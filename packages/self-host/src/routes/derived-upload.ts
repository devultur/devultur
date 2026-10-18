// Multipart for a video's DERIVED assets (a preset's MP4, any large transcode output). The
// runner doesn't go through POST /v1/upload (which generates a new key): it uploads to fixed keys `{vis}/video/{id}/(hls|mp4|
// thumbnails|storyboard)/…` with its credential (a service one, ideally scoped to that video). Without a prior
// pending, the multipart's create builds one on the fly for that key and from there it's the same protocol (parts,
// complete, abort) and the same offset-based L4 encryption as a client's large upload.
import type { Context } from "hono";
import { parseSecurityHeader, RESOURCE_SECURITY_HEADER, storageKey } from "../helpers";
import { isAuthenticated } from "../request-state";
import type { UploadPending, WorkerApp } from "../types";

const DERIVED_ASSET_KEY = /^(public|private)\/video\/[A-Za-z0-9-]+\/(hls|mp4|thumbnails|storyboard)\/[^/]+$/;

// What the runner uploads; anything else gets stored as binary (it doesn't pick an arbitrary servable content-type).
const DERIVED_CONTENT_TYPES = new Set([
	"video/mp4",
	"video/mp2t",
	"image/jpeg",
	"application/vnd.apple.mpegurl",
	"text/vtt",
]);

export function isDerivedAssetKey(key: string): boolean {
	return DERIVED_ASSET_KEY.test(key);
}

/**
 * On-the-fly pending for a derived asset's multipart create, or null if the request isn't one (a user
 * key, or no credential: a request with neither credential nor pending is already rejected before the route).
 * The resource's security override arrives via header, same as in the runner's single PUT.
 */
export async function derivedAssetPending(context: Context<WorkerApp>, key: string): Promise<UploadPending | null> {
	if (!isDerivedAssetKey(key) || !isAuthenticated(context)) return null;
	const body = (await context.req.json().catch(() => null)) as { contentType?: unknown } | null;
	const declared = typeof body?.contentType === "string" ? body.contentType : "";
	const security = parseSecurityHeader(context.req.header(RESOURCE_SECURITY_HEADER));
	return {
		contentType: DERIVED_CONTENT_TYPES.has(declared) ? declared : "application/octet-stream",
		storageKey: storageKey(context, key),
		...(security ? { security } : {}),
	};
}
