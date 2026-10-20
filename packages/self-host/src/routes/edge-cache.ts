// Edge cache (Cache API, per datacenter) for public delivery. The copy lives as long as the object's `Cache-Control`
// says (`s-maxage`/`max-age`, capped) and carries `Cache-Tag`s so it can be purged across ALL PoPs from Cloudflare's
// purge API: the Cache API docs guarantee tag-based purging for what `cache.put` stores (not the per-URL kind).
// On a hit, the object's original `Cache-Control` is restored (the copy keeps its own for the edge).
// A copy never outlives its object's `expiresAt` (its TTL is capped there, and a hit past it is a miss), and a response
// carrying the owner-only lock headers is never stored: those must not reach a shared cache.
import { edgeTtlSeconds, isAssetKey, sha256Hex } from "@devultur/core";
import type { StreamedKind } from "./object-response";

/** Cap on the edge TTL: if a purge is missed, deleted/replaced content stops being served after at most a week. */
export const MAX_EDGE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Cap on the background fill after a miss with Range (downloads the whole object). */
export const MAX_EDGE_CACHE_FILL_BYTES = 100 * 1024 * 1024;
/** Object's original `Cache-Control`, saved in the edge copy (never leaves to the client). */
const ORIGINAL_CACHE_CONTROL_HEADER = "x-devultur-cache-control";
/** The object's `expiresAt` (epoch ms), saved in the edge copy so a hit past it is a miss (never leaves to the client). */
const EDGE_EXPIRES_HEADER = "x-devultur-edge-expires";
/** Owner-only headers (`x-devultur-lock-until`, `x-devultur-lock-hold`): a response with one is never stored. */
const OWNER_HEADER_PREFIX = "x-devultur-lock";
const CACHE_TAG_HEADER = "Cache-Tag";
const TAG_HASH_LENGTH = 40;

/** `caches.default` only exists in the Workers runtime (in Node/tests there's no cache → it's skipped). */
export function publicEdgeCache(): Cache | null {
	if (typeof caches === "undefined") return null;
	return (caches as unknown as { default: Cache }).default;
}

/**
 * Unit that gets purged together: an asset is its own key; a generated media item (`{visibility}/{kind}/{id}/…`) is
 * its folder (raw, HLS, thumbnails and subtitles of a video fall under a single tag). Pure.
 */
export function purgeUnitOfKey(virtualKey: string): string {
	if (isAssetKey(virtualKey)) return virtualKey;
	return virtualKey.split("/").slice(0, 3).join("/");
}

/** The unit's tag: a hash (Cloudflare's tags are case-insensitive but paths aren't). */
export async function edgeCacheTag(storagePrefix: string, virtualKey: string): Promise<string> {
	const digest = await sha256Hex(new TextEncoder().encode(`${storagePrefix}${purgeUnitOfKey(virtualKey)}`));
	return `dv-o-${digest.slice(0, TAG_HASH_LENGTH)}`;
}

/** Tag for everything under a storage prefix (whole-prefix purge). Empty prefix = no tag. */
export function prefixEdgeCacheTag(storagePrefix: string): string | null {
	const prefix = storagePrefix.replace(/\/$/, "");
	return prefix ? `dv-p-${prefix}` : null;
}

async function edgeCacheTags(storagePrefix: string, virtualKey: string): Promise<string> {
	const prefixTag = prefixEdgeCacheTag(storagePrefix);
	const objectTag = await edgeCacheTag(storagePrefix, virtualKey);
	return prefixTag ? `${objectTag},${prefixTag}` : objectTag;
}

/** True when the copy's object is past its `expiresAt`: the hit isn't served (the origin answers `410`). Pure. */
export function isEdgeCopyExpired(hit: Response, now = Date.now()): boolean {
	const expiresAt = Number(hit.headers.get(EDGE_EXPIRES_HEADER));
	return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
}

/** The copy for `request`, ready for the client, or `null` on a miss (none, or its object expired since). */
export async function matchEdgeCopy(
	cache: Cache,
	request: Request,
	options: { isFormatNegotiated: boolean },
): Promise<Response | null> {
	const hit = await cache.match(request);
	if (!hit || isEdgeCopyExpired(hit)) return null;
	return responseFromEdgeHit(hit, options);
}

/** Response to the client from a hit: the object's `Cache-Control`, without the copy's internal headers. */
export function responseFromEdgeHit(hit: Response, options: { isFormatNegotiated: boolean }): Response {
	const headers = new Headers(hit.headers);
	// A variant's cache key already carries the negotiated format; the `Vary` comes back when serving.
	if (options.isFormatNegotiated) headers.set("Vary", "Accept");
	const original = headers.get(ORIGINAL_CACHE_CONTROL_HEADER);
	if (original) headers.set("Cache-Control", original);
	headers.delete(ORIGINAL_CACHE_CONTROL_HEADER);
	headers.delete(EDGE_EXPIRES_HEADER);
	headers.delete(CACHE_TAG_HEADER);
	return new Response(hit.body, { status: hit.status, headers });
}

export interface EdgeCopyTarget {
	cache: Cache;
	/** The request's URL, or the Worker's variant URL (`{origin}/__variant/{variantKey}`). */
	cacheKey: string;
	storagePrefix: string;
	virtualKey: string;
	/** `Cache-Control` the client receives (the object's own). */
	cacheControl: string;
	/** The object's `expiresAt` (epoch ms; a variant's is its original's): the copy's TTL ends there. */
	expiresAt?: number;
}

/** TTL of the copy on the edge. 0 = not stored (`no-cache`, `no-store`, `private`, no age). */
export function edgeTtlFor(cacheControl: string): number {
	return edgeTtlSeconds(cacheControl, MAX_EDGE_TTL_SECONDS);
}

/** TTL of `target`'s copy: its `Cache-Control`'s, capped at the object's `expiresAt`. 0 = not stored. Pure. */
export function edgeCopyTtl(target: Pick<EdgeCopyTarget, "cacheControl" | "expiresAt">, now = Date.now()): number {
	const ttl = edgeTtlFor(target.cacheControl);
	if (target.expiresAt === undefined) return ttl;
	return Math.max(0, Math.min(ttl, Math.floor((target.expiresAt - now) / 1000)));
}

const carriesOwnerHeaders = (headers: Headers) =>
	[...headers.keys()].some((name) => name.toLowerCase().startsWith(OWNER_HEADER_PREFIX));

/**
 * Stores the copy: its own TTL, the original `Cache-Control` and the object's expiry set aside, and the purge tags.
 * Nothing is stored when the TTL is 0 (the object expires within the second) or the response carries owner headers.
 */
export async function putEdgeCopy(target: EdgeCopyTarget, body: ReadableStream | null, headers: Headers) {
	const ttl = edgeCopyTtl(target);
	if (ttl <= 0 || carriesOwnerHeaders(headers)) {
		await body?.cancel();
		return;
	}
	const copyHeaders = new Headers(headers);
	copyHeaders.delete("Content-Range");
	copyHeaders.delete("Vary");
	copyHeaders.set(ORIGINAL_CACHE_CONTROL_HEADER, target.cacheControl);
	copyHeaders.set("Cache-Control", `public, max-age=${ttl}`);
	if (target.expiresAt !== undefined) copyHeaders.set(EDGE_EXPIRES_HEADER, String(target.expiresAt));
	copyHeaders.set(CACHE_TAG_HEADER, await edgeCacheTags(target.storagePrefix, target.virtualKey));
	await target.cache.put(target.cacheKey, new Response(body, { status: 200, headers: copyHeaders }));
}

/** Miss with Range (the typical first request from a `<video>`): the whole object gets cached separately. */
export async function fillEdgeCache(target: EdgeCopyTarget, bucket: R2Bucket, fullKey: string, headers: Headers) {
	if (edgeCopyTtl(target) <= 0 || carriesOwnerHeaders(headers)) return;
	const full = await bucket.get(fullKey);
	if (!full) return;
	const fullHeaders = new Headers(headers);
	fullHeaders.set("Content-Length", String(full.size));
	await putEdgeCopy(target, full.body, fullHeaders);
}

export interface DeliveredResponse {
	bucket: R2Bucket;
	/** Storage key of what was served (the original or the Worker variant) and its size. */
	servedKey: string;
	size: number;
	kind: StreamedKind;
	response: Response;
	headers: Headers;
}

/**
 * After a public delivery, stores its edge copy in the background. A full plain response is copied as is. A miss with
 * `Range` (the typical first request for a `<video>`) caches the whole object separately, so later ranges come from
 * the edge, bounded so huge videos aren't pulled at once. Anything else (decrypted, refused) isn't stored.
 */
export function cacheDelivered(
	waitUntil: (task: Promise<unknown>) => void,
	target: EdgeCopyTarget,
	delivered: DeliveredResponse,
): void {
	if (edgeCopyTtl(target) <= 0) return;
	if (delivered.kind === "plain-range" && delivered.size <= MAX_EDGE_CACHE_FILL_BYTES) {
		waitUntil(fillEdgeCache(target, delivered.bucket, delivered.servedKey, delivered.response.headers));
	}
	if (delivered.kind === "plain-full") {
		waitUntil(putEdgeCopy(target, delivered.response.clone().body, delivered.headers));
	}
}
