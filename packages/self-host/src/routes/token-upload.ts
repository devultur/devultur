// `POST /v1/token/upload`: an upload token scoped to a prefix under the `asset/` namespace, for a CI runner. It only
// works to CREATE uploads (single or multipart) under its prefix, with its visibility and its limits; never to read
// or delete. The `issueCredential` hook can narrow it to whatever the requesting credential is allowed to delegate.
import {
	assetRelativePath,
	normalizeAssetPrefix,
	type ObjectLock,
	type Visibility,
	validateLock,
} from "@devultur/core";
import type { Context } from "hono";
import type { UploadGrant } from "../export-types";
import { signViewerToken } from "../helpers";
import { cappedExpiry, decideCredential, withPluginClaims } from "../plugin-hooks";
import { getRequestState } from "../request-state";
import { audienceClaim, scopeClaim } from "../token-claims";
import type { WorkerApp } from "../types";
import { MAX_FILE_TTL_SECONDS } from "./upload-target";

export const UPLOAD_TOKEN_TYPE = "upload";
const MEDIA_WRITE_SCOPE = "media:write";
const DEFAULT_UPLOAD_TOKEN_TTL_SECONDS = 60 * 60;
/** Short-lived: it's a JWT (an auth layer can also reject it if the credential that issued it is no longer valid). */
export const MAX_UPLOAD_TOKEN_TTL_SECONDS = 24 * 60 * 60;

interface UploadTokenRequest {
	prefix?: unknown;
	expiresIn?: unknown;
	maxBytes?: unknown;
	maxFiles?: unknown;
	fileExpiresIn?: unknown;
	visibility?: unknown;
	lock?: unknown;
}

const isPositiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Optional positive integer field: `undefined` if not provided, `null` if provided but invalid. */
function optionalPositive(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined | null {
	if (value === undefined || value === null) return undefined;
	return isPositiveInteger(value) && value <= max ? value : null;
}

function parseVisibility(value: unknown): Visibility | null {
	if (value === undefined || value === null) return "private";
	return value === "public" || value === "private" ? value : null;
}

/** The token's `lock` claim: `undefined` if absent, `null` if present but not a valid lock (the token is refused). */
function lockClaim(value: unknown): ObjectLock | undefined | null {
	if (value === undefined) return undefined;
	const validation = validateLock(value);
	return validation.ok ? validation.lock : null;
}

/** Grant of the claims of a verified upload token. `null` if it isn't a valid upload token. Pure. */
export function uploadGrantFromClaims(payload: Record<string, unknown>): UploadGrant | null {
	if (payload.typ !== UPLOAD_TOKEN_TYPE || typeof payload.res !== "string" || typeof payload.jti !== "string") {
		return null;
	}
	if (payload.visibility !== "public" && payload.visibility !== "private") return null;
	const lock = lockClaim(payload.lock);
	if (lock === null) return null;
	return {
		tokenId: payload.jti,
		pathPrefix: payload.res,
		visibility: payload.visibility,
		...(isPositiveInteger(payload.max_bytes) ? { maxBytes: payload.max_bytes } : {}),
		...(isPositiveInteger(payload.max_files) ? { maxFiles: payload.max_files } : {}),
		...(isPositiveInteger(payload.file_ttl) ? { fileExpiresIn: payload.file_ttl } : {}),
		...(lock ? { lock } : {}),
	};
}

const badRequest = (context: Context<WorkerApp>, code: string, error: string) => context.json({ error, code }, 400);

export async function handleUploadToken(context: Context<WorkerApp>): Promise<Response> {
	const body = ((await context.req.json().catch(() => null)) ?? {}) as UploadTokenRequest;
	const prefix = normalizeAssetPrefix(body.prefix);
	if (!prefix) return badRequest(context, "invalid_prefix", "prefix must be a relative path like `exports/inst-1/`");
	const visibility = parseVisibility(body.visibility);
	if (!visibility) return badRequest(context, "invalid_visibility", "visibility must be `public` or `private`");
	const expiresIn = optionalPositive(body.expiresIn, MAX_UPLOAD_TOKEN_TTL_SECONDS);
	const maxBytes = optionalPositive(body.maxBytes);
	const maxFiles = optionalPositive(body.maxFiles);
	const fileExpiresIn = optionalPositive(body.fileExpiresIn, MAX_FILE_TTL_SECONDS);
	if (expiresIn === null) return badRequest(context, "invalid_expires_in", "expiresIn must be 1..86400 seconds");
	if (maxBytes === null || maxFiles === null) {
		return badRequest(context, "invalid_limits", "maxBytes and maxFiles must be positive integers");
	}
	if (fileExpiresIn === null) {
		return badRequest(context, "invalid_file_expires_in", "fileExpiresIn must be a positive number of seconds");
	}
	const lock = body.lock === undefined ? { ok: true as const, lock: undefined } : validateLock(body.lock);
	if (!lock.ok) return badRequest(context, "invalid_lock", lock.errors.join("; "));

	const pathPrefix = assetRelativePath(prefix);
	const now = Math.floor(Date.now() / 1000);
	const requestedExp = now + (expiresIn ?? DEFAULT_UPLOAD_TOKEN_TTL_SECONDS);
	// The hook decides whether the requesting credential can issue this for this prefix, and caps the expiry.
	const decision = await decideCredential(context, {
		kind: "upload",
		scopes: [MEDIA_WRITE_SCOPE],
		path: pathPrefix,
		expiresAt: requestedExp * 1000,
	});
	if (!decision.allow) return decision.response;
	const expiresAt = cappedExpiry(requestedExp, decision.expiresAt, (epochMs) => Math.floor(epochMs / 1000));
	const payload = withPluginClaims(
		{
			typ: UPLOAD_TOKEN_TYPE,
			jti: crypto.randomUUID(),
			res: pathPrefix,
			visibility,
			...scopeClaim([MEDIA_WRITE_SCOPE]),
			...audienceClaim(getRequestState(context).storagePrefix),
			iat: now,
			exp: expiresAt,
			...(maxBytes ? { max_bytes: maxBytes } : {}),
			...(maxFiles ? { max_files: maxFiles } : {}),
			...(fileExpiresIn ? { file_ttl: fileExpiresIn } : {}),
			...(lock.lock ? { lock: lock.lock } : {}),
		},
		decision,
	);
	const token = await signViewerToken(payload, context.env.DELIVERY_SIGN_SECRET);
	return context.json({
		token,
		prefix,
		visibility,
		expiresAt,
		...(maxBytes ? { maxBytes } : {}),
		...(maxFiles ? { maxFiles } : {}),
		...(fileExpiresIn ? { fileExpiresIn } : {}),
		...(lock.lock ? { lock: lock.lock } : {}),
	});
}
