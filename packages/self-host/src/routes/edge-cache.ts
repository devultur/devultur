// Edge cache (Cache API, per datacenter) for public delivery. The copy lives as long as the object's `Cache-Control`
// says (`s-maxage`/`max-age`, capped) and carries `Cache-Tag`s so it can be purged across ALL PoPs from Cloudflare's
// purge API: the Cache API docs guarantee tag-based purging for what `cache.put` stores (not the per-URL kind).
// On a hit, the object's original `Cache-Control` is restored (the copy keeps its own for the edge).
import { edgeTtlSeconds, isAssetKey, sha256Hex } from "@devultur/core";

/** Cap on the edge TTL: if a purge is missed, deleted/replaced content stops being served after at most a week. */
export const MAX_EDGE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Cap on the background fill after a miss with Range (downloads the whole object). */
export const MAX_EDGE_CACHE_FILL_BYTES = 100 * 1024 * 1024;
/** Object's original `Cache-Control`, saved in the edge copy (never leaves to the client). */
const ORIGINAL_CACHE_CONTROL_HEADER = "x-devultur-cache-control";
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

/** Response to the client from a hit: the object's `Cache-Control`, without the copy's internal headers. */
export function responseFromEdgeHit(hit: Response, options: { isFormatNegotiated: boolean }): Response {
	const headers = new Headers(hit.headers);
	// A variant's cache key already carries the negotiated format; the `Vary` comes back when serving.
	if (options.isFormatNegotiated) headers.set("Vary", "Accept");
	const original = headers.get(ORIGINAL_CACHE_CONTROL_HEADER);
	if (original) headers.set("Cache-Control", original);
	headers.delete(ORIGINAL_CACHE_CONTROL_HEADER);
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
}

/** TTL of the copy on the edge. 0 = not stored (`no-cache`, `no-store`, `private`, no age). */
export function edgeTtlFor(cacheControl: string): number {
	return edgeTtlSeconds(cacheControl, MAX_EDGE_TTL_SECONDS);
}

/** Stores the copy: its own TTL, the original `Cache-Control` set aside, and the purge tags. The caller already checked TTL > 0. */
export async function putEdgeCopy(target: EdgeCopyTarget, body: ReadableStream | null, headers: Headers) {
	const ttl = edgeTtlFor(target.cacheControl);
	const copyHeaders = new Headers(headers);
	copyHeaders.delete("Content-Range");
	copyHeaders.delete("Vary");
	copyHeaders.set(ORIGINAL_CACHE_CONTROL_HEADER, target.cacheControl);
	copyHeaders.set("Cache-Control", `public, max-age=${ttl}`);
	copyHeaders.set(CACHE_TAG_HEADER, await edgeCacheTags(target.storagePrefix, target.virtualKey));
	await target.cache.put(target.cacheKey, new Response(body, { status: 200, headers: copyHeaders }));
}

/** Miss with Range (the typical first request from a `<video>`): the whole object gets cached separately. */
export async function fillEdgeCache(target: EdgeCopyTarget, bucket: R2Bucket, fullKey: string, headers: Headers) {
	const full = await bucket.get(fullKey);
	if (!full) return;
	const fullHeaders = new Headers(headers);
	fullHeaders.set("Content-Length", String(full.size));
	await putEdgeCopy(target, full.body, fullHeaders);
}
