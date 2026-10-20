import {
	computeFingerprint,
	decodeEncryptionMeta,
	GENERATED_PRIVATE_CACHE_CONTROL,
	GENERATED_PUBLIC_CACHE_CONTROL,
	resolveSecurity,
	SESSION_HEADER,
	type SecurityPolicy,
	toPrivateCacheControl,
	visibilityFromKey,
} from "@devultur/core";
import { type Context, Hono } from "hono";
import { contentDispositionAttachment, loadStorageKey, storageKey, storagePrefix, verifyViewerToken } from "../helpers";
import { imageOriginUrl, readImageOriginScope, serveCloudflareTransform } from "../image/cloudflare";
import {
	hasTransformQuery,
	IMAGE_CONTENT_TYPES,
	type ImageTransformParams,
	parseTransformParams,
} from "../image/params";
import { ImageTransformsMode, isVariantKey, resolveTransformsMode } from "../image/transform-plan";
import { resolveWorkerVariant, workerVariantKey } from "../image/worker-transform";
import { lockHeaders } from "../object-lock/delivery";
import { getRequestState } from "../request-state";
import type { WorkerApp } from "../types";
import {
	type EdgeCopyTarget,
	edgeTtlFor,
	fillEdgeCache,
	MAX_EDGE_CACHE_FILL_BYTES,
	publicEdgeCache,
	putEdgeCopy,
	responseFromEdgeHit,
} from "./edge-cache";
import { handleKeyDelete, handleVideoDelete } from "./media-delete";
import { expiredResponse, isObjectExpired, streamObject } from "./object-response";
import { isStoryboardVttKey, storyboardVttResponse } from "./storyboard-vtt";
import { viewerTokenClaimRejection } from "./viewer-token-claims";

// An upload token (`typ: "upload"`) is signed with the same secret, but it does NOT unlock private content.
async function verifyDeliveryToken(token: string | undefined, secret: string) {
	const payload = await verifyViewerToken(token, secret);
	return payload && payload.typ !== "upload" ? payload : null;
}

export { type ImageTransformParams, parseTransformParams };

// `?download` forces the download (Content-Disposition: attachment) instead of showing it inline.
// Without an explicit `filename` it reuses the stored original name (only swapping `inline`→`attachment`,
// preserving the RFC 5987 encoding); if there isn't one, it falls back to the key's basename.
function downloadDisposition(storedDisposition: string | undefined, key: string, filename: string): string {
	if (filename) return contentDispositionAttachment(filename);
	if (storedDisposition?.startsWith("inline")) return `attachment${storedDisposition.slice("inline".length)}`;
	return contentDispositionAttachment(key.split("/").pop() || "download");
}

const media = new Hono<WorkerApp>();

media.get("/:key{.+}", async (context) => {
	const key = context.req.param("key");
	const fullKey = storageKey(context, key);
	const requestUrl = new URL(context.req.url);

	// Variants and the mezzanine are internal: they're requested with `?w=…` on the original, never by their own key.
	if (isVariantKey(key)) {
		return context.json({ error: "Not found" }, 404);
	}

	// Cloudflare Images subrequest asking for the original (fallback/mezzanine): `Via` + the signature of its URL and
	// of the storage prefix (image/cloudflare.ts). The parent request already passed the gate; `Via` alone isn't enough (spoofable).
	const callerScope = storagePrefix(context, "");
	const originScope = await readImageOriginScope(context.req.raw, context.env.DELIVERY_SIGN_SECRET);
	const isOriginRequest = originScope !== null && originScope === callerScope;
	const origin = { url: imageOriginUrl(requestUrl), scope: callerScope };

	// Visibility gate (authority = the path prefix, fixed at upload time; NEVER the client).
	// `public` → tokenless, cacheable. `private` → valid viewer token or 401.
	const visibility = visibilityFromKey(key) ?? "private";
	const isPrivate = visibility === "private";
	// Trusted read (the owning backend with its credential, already authorized by the auth layer): there's no viewer
	// token to verify, and its credential is NEVER copied into playlist URLs (which is why `token` stays empty).
	const isOwnerAccess = getRequestState(context).access?.trustedRead === true;
	const token = isOwnerAccess
		? undefined
		: (context.req.query("token") ?? context.req.header("Authorization")?.replace(/^Bearer\s+/i, ""));

	let tokenPayload: Record<string, unknown> | null = null;
	if (isPrivate && !isOriginRequest && !isOwnerAccess) {
		tokenPayload = await verifyDeliveryToken(token, context.env.DELIVERY_SIGN_SECRET);
		if (!tokenPayload) {
			return context.json({ error: "Unauthorized" }, 401);
		}
		const claimRejection = viewerTokenClaimRejection(tokenPayload, {
			storagePrefix: getRequestState(context).storagePrefix,
			key,
		});
		if (claimRejection) {
			console.warn(`[delivery] token rejected (${claimRejection.reason}) for ${key}`);
			return context.json({ error: claimRejection.error, code: claimRejection.code }, claimRejection.status);
		}
	}

	// L4 video: the HLS AES-128 key is served from the keys bucket (it's not in MEDIA_BUCKET). The
	// playlist references `{keyId}.key`; hls.js requests it with the token and decrypts client-side. Same
	// binding gate as the segments. Runs BEFORE the media fetch (`.key` is not a media object).
	// Scoped to `/hls/`: a user file named `algo.key` does NOT land here (it lives under `file/…`/`image/…`).
	if (key.includes("/hls/") && key.endsWith(".key") && !isOwnerAccess) {
		return serveEncryptionKey(context, key, tokenPayload);
	}

	// Edge cache (per datacenter) for public media: a background `<video>` or an image on a busy site
	// gets requested thousands of times → R2 is read once per PoP, not once per visitor. `match` resolves
	// the request's `Range` against the full cached object (native 206). Private media never leaves the
	// viewer's session. The Worker variant is just another R2 object → it also goes to the edge cache, with
	// cache key = its variant key (format already resolved from `Accept`, so `format=auto` doesn't mix avif/webp).
	// Cloudflare Images' fallback has its own cache.
	const transformParams = isOriginRequest ? null : parseTransformParams(requestUrl);
	const isFormatNegotiated = transformParams?.format === "auto";
	const workerParams =
		resolveTransformsMode(context.env.IMAGE_TRANSFORMS) === ImageTransformsMode.WORKER ? transformParams : null;
	const accept = context.req.header("Accept");
	const edgeCacheKey = workerParams
		? `${requestUrl.origin}/__variant/${workerVariantKey(fullKey, workerParams, accept)}`
		: requestUrl.toString();
	const isUncachedTransform = hasTransformQuery(requestUrl) && !workerParams;
	const edgeCache = isPrivate || isOriginRequest || isUncachedTransform ? null : publicEdgeCache();
	if (edgeCache) {
		// With the request's headers: `match` resolves the `Range` against the cached object (native 206).
		const cacheRequest = workerParams ? new Request(edgeCacheKey, context.req.raw) : context.req.raw;
		const hit = await edgeCache.match(cacheRequest);
		// The copy lives as long as the object says (see edge-cache.ts); the client gets the object's `Cache-Control`.
		if (hit) return responseFromEdgeHit(hit, { isFormatNegotiated });
	}

	let object = await context.env.MEDIA_BUCKET.get(fullKey);
	// What actually gets served: the original, or the Worker variant (same L4/Range/cache pipeline).
	let servedKey = fullKey;
	if (!object) {
		return context.json({ error: "Not found" }, 404);
	}
	if (isObjectExpired(object.customMetadata)) return expiredResponse();

	// L3: verify the session/IP binding against the request (after the fetch, to read the per-resource
	// override from the metadata). Mismatch → 401 `session_mismatch` → the provider re-issues the token.
	if (tokenPayload && (await bindingMismatch(context, tokenPayload, object.customMetadata))) {
		return context.json({ error: "Session mismatch", code: "session_mismatch" }, 401);
	}

	let contentType = object.httpMetadata?.contentType ?? "application/octet-stream";
	const isPlaylist = key.endsWith(".m3u8");
	// The `Cache-Control` set at upload time (preset/config rule); previous objects don't have it → fall back to
	// the one for a generated id. Private: only the browser cache (`private`), never shared/CDN.
	const cacheControl = servedCacheControl(object.httpMetadata?.cacheControl, isPrivate);

	// `?download` (optionally `?download=<name>`) → attachment. `.get` returns "" with no value, null if absent.
	const downloadParam = requestUrl.searchParams.get("download");
	const isDownload = downloadParam !== null;

	if (isPlaylist && token) {
		const playlistText = await object.text();
		// Tokenizes the segment/variant lines (.ts/.m3u8) and also the L4 key URI inside
		// `#EXT-X-KEY` (if the video is encrypted) → hls.js sends the token when requesting the key.
		const rewritten = playlistText
			.replace(/^([^#\s].+\.(?:ts|m3u8))$/gm, `$1?token=${token}`)
			.replace(/(#EXT-X-KEY:[^\n]*URI=")([^"]+)(")/g, `$1$2?token=${token}$3`);
		return new Response(rewritten, {
			headers: {
				"Content-Type": "application/vnd.apple.mpegurl",
				"Cache-Control": "no-cache",
			},
		});
	}

	const imageParams = IMAGE_CONTENT_TYPES.has(contentType) ? transformParams : null;
	const disposition = isDownload
		? downloadDisposition(object.httpMetadata?.contentDisposition, key, downloadParam ?? "")
		: undefined;
	let isServingVariant = false;

	if (imageParams && workerParams) {
		const variant = await resolveWorkerVariant({
			env: context.env,
			fullKey,
			original: object,
			params: workerParams,
			accept,
			origin,
		});
		if (variant.kind === "variant") {
			object = variant.object;
			servedKey = variant.storageKey;
			contentType = object.httpMetadata?.contentType ?? contentType;
			isServingVariant = true;
		} else {
			console.log(`[image-transforms] fallback to cloudflare: ${variant.reason}`);
		}
	}

	if (imageParams && !isServingVariant) {
		return serveCloudflareTransform({
			origin,
			secret: context.env.DELIVERY_SIGN_SECRET,
			params: imageParams,
			accept,
			sourceType: contentType,
			cacheControl,
			disposition,
		});
	}

	// L4 (decryption), `Range`, and integrity, over whatever actually gets served (original or Worker variant).
	// Runs AFTER the transform branch: the Cloudflare fallback delegates to the origin subrequest (which loads and
	// uses the key), so the parent request doesn't spend an extra GET on the keys bucket.
	// Storyboard with a token: the VTT comes back rewritten (each sprite with the viewer's token), like the HLS
	// playlist. An encrypted (L4) VTT is decrypted with its key before rewriting; no key → 500 (we never leak ciphertext).
	if (token && isStoryboardVttKey(key) && object.body) {
		const enc = decodeEncryptionMeta(object.customMetadata?.enc);
		const loaded = enc ? await loadStorageKey(context.env.KEYS_BUCKET, fullKey, enc.keyId) : null;
		if (enc && !loaded) return context.json({ error: "Decryption key unavailable" }, 500);
		const decryption = enc && loaded ? { key: loaded.key, iv: enc.iv } : null;
		return storyboardVttResponse(object.body, token, decryption);
	}

	const headers = new Headers();
	headers.set("Content-Type", contentType);
	headers.set("Cache-Control", cacheControl);
	if (isServingVariant && isFormatNegotiated) headers.set("Vary", "Accept");
	if (disposition) {
		headers.set("Content-Disposition", disposition);
	} else if (object.httpMetadata?.contentDisposition) {
		headers.set("Content-Disposition", object.httpMetadata.contentDisposition);
	}
	if (isOwnerAccess) for (const [name, value] of await lockHeaders(context, key, object)) headers.set(name, value);

	const { response, kind } = await streamObject({
		bucket: context.env.MEDIA_BUCKET,
		keysBucket: context.env.KEYS_BUCKET,
		fullKey: servedKey,
		object,
		headers,
		range: context.req.header("Range"),
	});
	// No freshness lifetime for a shared cache (`no-cache`, `no-store`) means no copy at the edge.
	if (!edgeCache || edgeTtlFor(cacheControl) <= 0) return response;
	const target: EdgeCopyTarget = {
		cache: edgeCache,
		cacheKey: edgeCacheKey,
		storagePrefix: getRequestState(context).storagePrefix,
		virtualKey: key,
		cacheControl,
	};
	// Miss with Range (the typical first request for a `<video>`): the full object is cached separately so that
	// later ranges come from the edge. Bounded so we don't pull huge videos all at once.
	if (kind === "plain-range" && object.size <= MAX_EDGE_CACHE_FILL_BYTES) {
		context.executionCtx.waitUntil(fillEdgeCache(target, context.env.MEDIA_BUCKET, servedKey, response.headers));
	}
	if (kind === "plain-full") {
		context.executionCtx.waitUntil(putEdgeCopy(target, response.clone().body, headers));
	}
	return response;
});

/** `Cache-Control` served: the one stored on the object (for private, no shared caches) or the one for a generated id. */
export function servedCacheControl(stored: string | undefined, isPrivate: boolean): string {
	if (!stored) return isPrivate ? GENERATED_PRIVATE_CACHE_CONTROL : GENERATED_PUBLIC_CACHE_CONTROL;
	return isPrivate ? toPrivateCacheControl(stored) : stored;
}

media.delete("/videos/:videoId", handleVideoDelete);
media.delete("/:key{.+}", handleKeyDelete);

// Per-resource security override, stored in the R2 object's custom metadata (JSON). Undefined
// if there's no override → the gate falls back to the config's policy (the token's `bind` claim).
function parseSecurityMeta(raw: string | undefined): SecurityPolicy | undefined {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as SecurityPolicy;
	} catch {
		return undefined;
	}
}

// True if the token's binding does NOT match the current request (session/IP). Resolves the effective
// policy (resource → config → default) and compares the matching fingerprint. Old tokens without
// `nonce`/`fp` don't break (backward-compat). Cloudflare Images origin subrequests never reach here.
async function bindingMismatch(
	context: Context<WorkerApp>,
	payload: Record<string, unknown>,
	customMetadata: Record<string, string> | undefined,
): Promise<boolean> {
	const policy = resolveSecurity(
		parseSecurityMeta(customMetadata?.security),
		payload.bind as SecurityPolicy | undefined,
	);
	if (!policy.sessionBinding) return false;

	const userId = payload.sub as string | undefined;
	const nonce = payload.nonce as string | undefined;
	if (!userId || !nonce) return false;

	// The session secret travels in the header (not the URL) → a leaked `?token=` doesn't carry it. No
	// header (`""`) against a token issued without a secret (`""`) → they match (binding is a no-op).
	const sessionSecret = context.req.header(SESSION_HEADER) ?? "";
	if (policy.ipBinding) {
		const ip = context.req.header("CF-Connecting-IP") ?? context.req.header("X-Forwarded-For") ?? "unknown";
		return (await computeFingerprint(userId, sessionSecret, nonce, ip)) !== (payload.fpip as string);
	}
	return (await computeFingerprint(userId, sessionSecret, nonce)) !== (payload.fp as string);
}

// Serves an encrypted HLS stream's AES-128 key from the keys bucket, gated by the same token/binding
// as the segments. Returns the 16 raw bytes (hls.js decrypts client-side). Only encrypted private media
// reaches here (always with a token). Request: `{visibility}/video/{id}/hls/{keyId}.key`; the material lives at
// `${storageKey(hls/{keyId})}/{... }` derived from the object's storage key — transcode stored it there.
async function serveEncryptionKey(
	context: Context<WorkerApp>,
	key: string,
	tokenPayload: Record<string, unknown> | null,
): Promise<Response> {
	if (!tokenPayload) {
		return context.json({ error: "Unauthorized" }, 401);
	}
	// The key object's path = the request without the `.key` suffix, with the storage prefix (symmetric with
	// transcode). `keyId` doesn't apply here because the key IS the object at that path (not a sub-object).
	const keyObjectPath = storageKey(context, key.replace(/\.key$/, ""));
	const stored = context.env.KEYS_BUCKET ? await context.env.KEYS_BUCKET.get(keyObjectPath) : null;
	if (!stored) {
		return context.json({ error: "Not found" }, 404);
	}
	// Per-resource binding: transcode stored the video's override in the key's metadata.
	if (await bindingMismatch(context, tokenPayload, stored.customMetadata)) {
		return context.json({ error: "Session mismatch", code: "session_mismatch" }, 401);
	}
	return new Response(stored.body, {
		headers: {
			"Content-Type": "application/octet-stream",
			"Content-Length": String(stored.size),
			// The key must never be cached by a CDN/proxy: it's the secret that protects the stream.
			"Cache-Control": "private, no-store",
		},
	});
}

export { downloadDisposition, media };
