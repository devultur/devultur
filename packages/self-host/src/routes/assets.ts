// `GET /v1/assets?prefix=&visibility=&cursor=&limit=`: lists the `asset/` namespace of the storage prefix (what a sync
// script compares against disk). Paginated over R2; without `visibility` it walks private entries first, then public
// ones, with a single cursor. Auth (worker secret or an auth middleware) already authorized the listing and the prefix.
import { ASSET_NAMESPACE, normalizeAssetPrefix, type Visibility } from "@devultur/core";
import { Hono } from "hono";
import { storagePrefix } from "../helpers";
import type { WorkerApp } from "../types";
import { isObjectExpired } from "./object-response";
import { ObjectMeta } from "./upload-integrity";

export const MAX_ASSET_LIST_LIMIT = 1000;
const VISIBILITY_ORDER: Visibility[] = ["private", "public"];

export interface AssetListEntry {
	key: string;
	path: string;
	size: number;
	etag: string;
	sha256: string | null;
	sha256Verified: boolean;
	uploaded: string;
	cacheControl: string | null;
	visibility: Visibility;
}

// `include` exists at runtime (compat ≥ 2022-08-04 requires it to fetch the metadata) but not in the types of
// workers-types' default entrypoint.
type R2ListWithMetadata = R2ListOptions & { include: Array<"httpMetadata" | "customMetadata"> };

interface ListPosition {
	visibility: Visibility;
	cursor?: string;
}

/** `prefix` from the query → prefix inside `asset/` (`site/`). `""` = everything; `null` = invalid. Pure. */
export function parseListPrefix(raw: string | undefined): string | null {
	if (!raw?.trim()) return "";
	return normalizeAssetPrefix(raw);
}

/** Opaque cursor `{visibility}:{R2 cursor}`. `null` = invalid or for a visibility that wasn't requested. Pure. */
export function parseListCursor(raw: string | undefined, visibilities: Visibility[]): ListPosition | null {
	if (!raw) return { visibility: visibilities[0] as Visibility };
	const separator = raw.indexOf(":");
	const visibility = raw.slice(0, separator) as Visibility;
	if (separator < 0 || !visibilities.includes(visibility)) return null;
	const cursor = raw.slice(separator + 1);
	return { visibility, ...(cursor ? { cursor } : {}) };
}

function parseLimit(raw: string | undefined): number {
	const limit = Number(raw);
	if (!Number.isInteger(limit) || limit <= 0) return MAX_ASSET_LIST_LIMIT;
	return Math.min(limit, MAX_ASSET_LIST_LIMIT);
}

function toEntry(object: R2Object, storageRoot: string, visibility: Visibility): AssetListEntry {
	const key = object.key.slice(storageRoot.length);
	const sha256 = object.customMetadata?.[ObjectMeta.SHA256] ?? null;
	return {
		key,
		path: key.slice(`${visibility}/${ASSET_NAMESPACE}/`.length),
		size: object.size,
		etag: object.httpEtag,
		sha256,
		sha256Verified: Boolean(sha256) && object.customMetadata?.[ObjectMeta.SHA256_VERIFIED] === "true",
		uploaded: object.uploaded.toISOString(),
		cacheControl: object.httpMetadata?.cacheControl ?? null,
		visibility,
	};
}

function nextCursor(listing: R2Objects, position: ListPosition, visibilities: Visibility[]): string | null {
	if (listing.truncated) return `${position.visibility}:${listing.cursor}`;
	const next = visibilities[visibilities.indexOf(position.visibility) + 1];
	return next ? `${next}:` : null;
}

const assets = new Hono<WorkerApp>();

assets.get("/", async (context) => {
	const prefix = parseListPrefix(context.req.query("prefix"));
	if (prefix === null) {
		return context.json(
			{ error: "prefix must be a relative path of [A-Za-z0-9._-] segments", code: "invalid_prefix" },
			400,
		);
	}
	const requested = context.req.query("visibility");
	const visibilities = VISIBILITY_ORDER.filter((visibility) => !requested || visibility === requested);
	const position = visibilities.length > 0 ? parseListCursor(context.req.query("cursor"), visibilities) : null;
	if (!position) return context.json({ error: "Invalid cursor or visibility", code: "invalid_cursor" }, 400);

	const storageRoot = storagePrefix(context, "");
	const listOptions: R2ListWithMetadata = {
		prefix: `${storageRoot}${position.visibility}/${ASSET_NAMESPACE}/${prefix}`,
		limit: parseLimit(context.req.query("limit")),
		...(position.cursor ? { cursor: position.cursor } : {}),
		include: ["httpMetadata", "customMetadata"],
	};
	const listing = await context.env.MEDIA_BUCKET.list(listOptions);
	const objects = listing.objects
		.filter((object) => !isObjectExpired(object.customMetadata))
		.map((object) => toEntry(object, storageRoot, position.visibility));
	return context.json({ objects, cursor: nextCursor(listing, position, visibilities) });
});

export { assets };
