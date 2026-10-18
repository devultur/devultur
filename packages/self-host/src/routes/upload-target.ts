// Where a new upload lands and under which rules: a generated key (`{visibility}/{kind}/{id}/{file}`) or a
// client-supplied path under the `asset/` namespace (`{visibility}/asset/{path}`), an upload token's caps (prefix,
// visibility, size, file count, TTL), and the file's TTL. Pure except for the `maxFiles` counter (KV, best-effort).
import {
	assetRelativePath,
	type CacheRule,
	DEFAULT_ASSET_CACHE_CONTROL,
	filePath,
	generateId,
	imagePath,
	isWithinPathPrefix,
	MediaType,
	matchCacheRule,
	normalizeAssetPath,
	normalizeSha256,
	resolveCacheControl,
	type Visibility,
	videoRawPath,
} from "@devultur/core";
import type { UploadGrant } from "../export-types";
import { sanitizeFilename } from "../helpers";
import type { UploadRequest } from "../types";
import { TOKEN_REJECTED_CODE } from "./viewer-token-claims";

/** Maximum TTL for a file (1 year): anything beyond is almost certainly a units mistake (ms instead of s). */
export const MAX_FILE_TTL_SECONDS = 365 * 24 * 60 * 60;
const MAX_FILES_COUNTER_TTL_SECONDS = 24 * 60 * 60;
const MAX_FILES_PREFIX = "upload-token-files";

export interface UploadTargetError {
	error: string;
	code: string;
	status: 400 | 403 | 413;
}

export interface UploadTarget {
	/** Virtual key (`{visibility}/…`). */
	key: string;
	/** The media's id: the generated uuid, or the full virtual key for an asset. */
	id: string;
	visibility: Visibility;
	isAsset: boolean;
	/** Path under `asset/` (assets only). */
	assetPath?: string;
}

const failure = (status: UploadTargetError["status"], code: string, error: string): UploadTargetError => ({
	status,
	code,
	error,
});

export function isUploadTargetError(value: unknown): value is UploadTargetError {
	return typeof value === "object" && value !== null && "code" in value && "status" in value;
}

function generatedKindPath(mediaType: MediaType, id: string, filename: string): string {
	const safeFilename = sanitizeFilename(filename);
	if (mediaType === MediaType.VIDEO) return videoRawPath(id, safeFilename);
	if (mediaType === MediaType.IMAGE) return imagePath(id, safeFilename);
	return filePath(id, safeFilename);
}

// The upload token doesn't allow this file: the caller only learns that the token was rejected, the log says why.
function tokenRejected(reason: "resource" | "visibility", path: unknown): UploadTargetError {
	console.warn(`[upload] token rejected (${reason}) for path ${String(path)}`);
	return failure(403, TOKEN_REJECTED_CODE, "Token rejected");
}

function assetTarget(rawPath: unknown, visibility: Visibility, grant: UploadGrant | undefined) {
	const assetPath = normalizeAssetPath(rawPath);
	if (!assetPath) {
		return failure(400, "invalid_path", "path must be a relative path of [A-Za-z0-9._-] segments, without `..`");
	}
	const relativePath = assetRelativePath(assetPath);
	if (grant && !isWithinPathPrefix(relativePath, grant.pathPrefix)) return tokenRejected("resource", relativePath);
	const key = `${visibility}/${relativePath}`;
	return { key, id: key, visibility, isAsset: true, assetPath };
}

/**
 * The upload's key. With `path` → an asset; an upload token REQUIRES `path` within its prefix and its visibility (a
 * different `visibility` is a 403, never silently rewritten). Without `path` → a generated key as usual.
 */
export function resolveUploadTarget(
	body: UploadRequest,
	mediaType: MediaType,
	visibility: Visibility,
	grant: UploadGrant | undefined,
): UploadTarget | UploadTargetError {
	if (grant && body.path === undefined) {
		return failure(400, "path_required", "an upload token can only create files at an explicit `path`");
	}
	if (grant && body.visibility && body.visibility !== grant.visibility) return tokenRejected("visibility", body.path);
	if (body.path !== undefined) return assetTarget(body.path, grant?.visibility ?? visibility, grant);
	const id = generateId();
	return { key: `${visibility}/${generatedKindPath(mediaType, id, body.filename)}`, id, visibility, isAsset: false };
}

/**
 * The file's expiry (epoch ms). The token's TTL and the scope's cap (`maxFileLifetimeSeconds`) act as the default and
 * the ceiling: the smallest of the three wins. `undefined` = no TTL; error if `expiresIn` isn't an integer number of
 * seconds in (0, 1 year].
 */
export function resolveExpiresAt(
	requested: unknown,
	grant: UploadGrant | undefined,
	now: number,
	maxTtlSeconds?: number,
): number | undefined | UploadTargetError {
	const hasRequest = requested !== undefined && requested !== null;
	const isValid = typeof requested === "number" && Number.isInteger(requested) && requested > 0;
	if (hasRequest && (!isValid || (requested as number) > MAX_FILE_TTL_SECONDS)) {
		return failure(400, "invalid_expires_in", "expiresIn must be a positive integer number of seconds (max 1 year)");
	}
	const candidates = [hasRequest ? (requested as number) : undefined, grant?.fileExpiresIn, maxTtlSeconds];
	const ttls = candidates.filter((ttl): ttl is number => typeof ttl === "number" && ttl > 0);
	return ttls.length > 0 ? now + Math.min(...ttls) * 1000 : undefined;
}

/** Declared sha256 (body). `undefined` = not declared; error if it's present but not 64-char hex. */
export function resolveDeclaredSha256(raw: unknown): string | undefined | UploadTargetError {
	if (raw === undefined || raw === null) return undefined;
	return normalizeSha256(raw) ?? failure(400, "invalid_sha256", "sha256 must be a 64-character hex string");
}

/** Effective maximum size: the smaller of the config's rule and the token's. */
export function effectiveMaxBytes(ruleMax: number | undefined, grant: UploadGrant | undefined): number | undefined {
	const limits = [ruleMax, grant?.maxBytes].filter((limit): limit is number => typeof limit === "number");
	return limits.length > 0 ? Math.min(...limits) : undefined;
}

/**
 * Counts a file against the token's `maxFiles`. Best-effort: KV isn't atomic, two simultaneous creates can both
 * slip through on the last slot. Errors once none are left.
 */
export async function claimTokenFileSlot(kv: KVNamespace, grant: UploadGrant): Promise<UploadTargetError | null> {
	if (!grant.maxFiles) return null;
	const counterKey = `${MAX_FILES_PREFIX}:${grant.tokenId}`;
	const used = Number((await kv.get(counterKey)) ?? "0");
	if (used >= grant.maxFiles) {
		return failure(403, "max_files_reached", `the upload token already created ${grant.maxFiles} files`);
	}
	await kv.put(counterKey, String(used + 1), { expirationTtl: MAX_FILES_COUNTER_TTL_SECONDS });
	return null;
}

/**
 * The `Cache-Control` stored on the object. Asset: the explicit one (400 if invalid), otherwise the longest
 * matching prefix rule, otherwise the short default. Generated id: `undefined` → delivery serves `immutable` (the URL is never reused).
 */
export function resolveObjectCacheControl(
	requested: unknown,
	target: UploadTarget,
	rules: readonly CacheRule[] | undefined,
): string | undefined | UploadTargetError {
	if (!target.isAsset || !target.assetPath) return undefined;
	if (requested !== undefined && requested !== null) {
		return (
			resolveCacheControl(requested) ??
			failure(400, "invalid_cache_control", "cacheControl must be immutable, revalidate, no-cache or a valid header")
		);
	}
	return matchCacheRule(rules, target.assetPath)?.cacheControl ?? DEFAULT_ASSET_CACHE_CONTROL;
}

/** Media type from content-type. `null` = can't be inferred (text/*, audio/*, …). */
export function inferMediaType(contentType: string): MediaType | null {
	if (contentType.startsWith("video/")) return MediaType.VIDEO;
	if (contentType.startsWith("image/")) return MediaType.IMAGE;
	if (contentType.startsWith("application/")) return MediaType.FILE;
	return null;
}
