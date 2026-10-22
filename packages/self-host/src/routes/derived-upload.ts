// Multipart for a video's DERIVED assets (a preset's MP4, any large transcode output). The
// runner doesn't go through POST /v1/upload (which generates a new key): it uploads to fixed keys `{vis}/video/{id}/(hls|mp4|
// thumbnails|storyboard)/…` with its credential (a service one, ideally scoped to that video). Without a prior
// pending, the multipart's create builds one on the fly for that key and from there it's the same protocol (parts,
// complete, abort) and the same offset-based L4 encryption as a client's large upload.
// A derived output expires with its video: it inherits the raw's `expiresAt`, so past it a viewer gets the same `410`
// on the HLS, MP4, poster and storyboard as on the raw.
import type { Context } from "hono";
import { parseSecurityHeader, RESOURCE_SECURITY_HEADER, storageKey } from "../helpers";
import { getRequestState, isAuthenticated } from "../request-state";
import type { UploadPending, WorkerApp } from "../types";
import { objectExpiresAt } from "./object-response";

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

/** A video has one raw (a few at most): one list page covers them. */
const RAW_LIST_LIMIT = 100;

// `include` exists at runtime (compat ≥ 2022-08-04 requires it to fetch the metadata) but not in workers-types' types.
type R2ListWithMetadata = R2ListOptions & { include: Array<"customMetadata"> };

/**
 * The `expiresAt` (epoch ms) a derived output (virtual `key`) inherits: the earliest of its video's raws', from one
 * list of the raw folder. `undefined` for any other key, or when no raw carries one. The raw is read at write time,
 * which is while the transcode runs (`deleteOriginalOnSuccess` deletes it only after `transcode.complete`).
 */
export async function inheritedExpiresAt(context: Context<WorkerApp>, key: string): Promise<number | undefined> {
	if (!isDerivedAssetKey(key)) return undefined;
	const videoFolder = key.split("/").slice(0, 3).join("/");
	const options: R2ListWithMetadata = {
		prefix: `${getRequestState(context).storagePrefix}${videoFolder}/raw/`,
		limit: RAW_LIST_LIMIT,
		include: ["customMetadata"],
	};
	const listing = await context.env.MEDIA_BUCKET.list(options);
	const expiries = listing.objects
		.map((raw) => objectExpiresAt(raw.customMetadata))
		.filter((expiresAt): expiresAt is number => expiresAt !== undefined);
	return expiries.length > 0 ? Math.min(...expiries) : undefined;
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
	const expiresAt = await inheritedExpiresAt(context, key);
	return {
		contentType: DERIVED_CONTENT_TYPES.has(declared) ? declared : "application/octet-stream",
		storageKey: storageKey(context, key),
		isDerived: true,
		...(security ? { security } : {}),
		...(expiresAt ? { expiresAt } : {}),
	};
}
