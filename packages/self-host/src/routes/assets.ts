// `GET /v1/assets?prefix=&visibility=&cursor=&limit=`: lists the `asset/` namespace of the storage prefix (what a sync
// script compares against disk). Paginated over R2; without `visibility` it walks private entries first, then public
// ones, with a single cursor. Auth (worker secret or an auth middleware) already authorized the listing and the prefix.
// An expired entry costs one read of its lock record (to tell retained from gone), so a page reads at most
// MAX_EXPIRED_LOOKUPS of them: past that it ends early, with a cursor that resumes right after the last entry it covered.
import { ASSET_NAMESPACE, normalizeAssetPrefix, type Visibility } from "@devultur/core";
import { Hono } from "hono";
import { storagePrefix } from "../helpers";
import { type Retained, retainedOf } from "../object-lock/delivery";
import type { WorkerApp } from "../types";
import { isObjectExpired } from "./object-response";
import { ObjectMeta } from "./upload-integrity";

export const MAX_ASSET_LIST_LIMIT = 1000;
/**
 * Lock-record reads per page (one subrequest each, plus the listing's own): well under the Workers subrequest limit
 * on any plan, whatever share of the page has expired.
 */
export const MAX_EXPIRED_LOOKUPS = 32;
const VISIBILITY_ORDER: Visibility[] = ["private", "public"];
/** Marks a cursor that resumes after a key (a page cut short by its lookups) rather than an R2 cursor. */
const RESUME_AFTER_MARK = "~";

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
	/** Past its `expiresAt` but still retained: listed (the owner can still read it), and not deleted. */
	expired?: true;
	/** The retention that keeps an expired entry (its effective expiry), when it has a date. */
	retainedUntil?: string;
	/** An expired entry kept by a hold. */
	hold?: true;
}

// `include` exists at runtime (compat ≥ 2022-08-04 requires it to fetch the metadata) but not in the types of
// workers-types' default entrypoint.
type R2ListWithMetadata = R2ListOptions & { include: Array<"httpMetadata" | "customMetadata"> };

interface ListPosition {
	visibility: Visibility;
	cursor?: string;
	/** Virtual key the page starts after (the previous page ran out of lookups). */
	startAfter?: string;
}

/** `prefix` from the query → prefix inside `asset/` (`site/`). `""` = everything; `null` = invalid. Pure. */
export function parseListPrefix(raw: string | undefined): string | null {
	if (!raw?.trim()) return "";
	return normalizeAssetPrefix(raw);
}

/**
 * Opaque cursor `{visibility}:{R2 cursor}`, or `{visibility}:~{virtual key}` to resume after a key. `null` = invalid or
 * for a visibility that wasn't requested. Pure.
 */
export function parseListCursor(raw: string | undefined, visibilities: Visibility[]): ListPosition | null {
	if (!raw) return { visibility: visibilities[0] as Visibility };
	const separator = raw.indexOf(":");
	const visibility = raw.slice(0, separator) as Visibility;
	if (separator < 0 || !visibilities.includes(visibility)) return null;
	const cursor = raw.slice(separator + 1);
	if (!cursor.startsWith(RESUME_AFTER_MARK)) return { visibility, ...(cursor ? { cursor } : {}) };
	try {
		return { visibility, startAfter: decodeURIComponent(cursor.slice(RESUME_AFTER_MARK.length)) };
	} catch {
		return null;
	}
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

const resumeCursor = (visibility: Visibility, afterKey: string) =>
	`${visibility}:${RESUME_AFTER_MARK}${encodeURIComponent(afterKey)}`;

const expiredEntry = (entry: AssetListEntry, retained: Retained): AssetListEntry => ({
	...entry,
	expired: true,
	...(retained.until ? { retainedUntil: retained.until } : {}),
	...(retained.hold ? { hold: true } : {}),
});

interface ListedPage {
	objects: AssetListEntry[];
	/** Virtual key of the last entry covered, when the page ran out of lookups before the listing's end. */
	cutAfter?: string;
}

/** The listing's entries: an expired one only while a lock retains it (marked), up to MAX_EXPIRED_LOOKUPS of them. */
async function listedEntries(bucket: R2Bucket, listing: R2Objects, storageRoot: string, visibility: Visibility) {
	const page: ListedPage = { objects: [] };
	let lookups = 0;
	let lastKey: string | undefined;
	for (const object of listing.objects) {
		const entry = toEntry(object, storageRoot, visibility);
		if (isObjectExpired(object.customMetadata)) {
			if (lookups === MAX_EXPIRED_LOOKUPS) return { ...page, cutAfter: lastKey };
			lookups += 1;
			const retained = await retainedOf(bucket, { root: storageRoot, key: entry.key }, object);
			if (retained) page.objects.push(expiredEntry(entry, retained));
		} else {
			page.objects.push(entry);
		}
		lastKey = entry.key;
	}
	return page;
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
		...(position.startAfter ? { startAfter: `${storageRoot}${position.startAfter}` } : {}),
		include: ["httpMetadata", "customMetadata"],
	};
	const listing = await context.env.MEDIA_BUCKET.list(listOptions);
	const page = await listedEntries(context.env.MEDIA_BUCKET, listing, storageRoot, position.visibility);
	const cursor = page.cutAfter
		? resumeCursor(position.visibility, page.cutAfter)
		: nextCursor(listing, position, visibilities);
	return context.json({ objects: page.objects, cursor });
});

export { assets };
