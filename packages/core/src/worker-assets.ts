// `client.assets`: paginated listing of the `asset/` namespace (what a sync script uses to find what changed).
import type { Visibility } from "./media";

/** An object from the `asset/` namespace as `GET /v1/assets` lists it. */
export interface AssetEntry {
	/** Virtual key (`public/asset/site/app.js`). */
	key: string;
	/** Path within `asset/` (`site/app.js`). */
	path: string;
	size: number;
	etag: string;
	sha256: string | null;
	/** `true`: the worker hashed the bytes. `false`: declared sha256 (multipart) or absent. */
	sha256Verified: boolean;
	/** ISO 8601. */
	uploaded: string;
	cacheControl: string | null;
	visibility: Visibility;
	/**
	 * Past its `expiresAt` but still retained by a lock: viewers get `410`, the worker's credential can still read it,
	 * and it isn't deleted until its lock ends. Absent on a live entry (expired free entries aren't listed).
	 */
	expired?: true;
	/** The effective expiry of the retention keeping an expired entry, when it has a date (ISO 8601). */
	retainedUntil?: string;
	/** An expired entry kept by a hold. */
	hold?: true;
}

export interface ListAssetsOptions {
	/** Prefix within `asset/` (`site/`). Empty = the whole namespace the key can reach. */
	prefix?: string;
	/** A single visibility. Absent = both (private first). */
	visibility?: Visibility;
	cursor?: string;
	/** Page size (1-1000, default 1000). */
	limit?: number;
}

export interface AssetListing {
	objects: AssetEntry[];
	/** For the next page; `null` = no more. */
	cursor: string | null;
}

export interface AssetsClient {
	/** One page of the listing (within the prefix the credential can reach). */
	list(options?: ListAssetsOptions): Promise<AssetListing>;
	/** All pages. */
	listAll(options?: Omit<ListAssetsOptions, "cursor">): AsyncGenerator<AssetEntry>;
}

type JsonRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export function assetListQuery(options: ListAssetsOptions): string {
	const params = new URLSearchParams();
	if (options.prefix) params.set("prefix", options.prefix);
	if (options.visibility) params.set("visibility", options.visibility);
	if (options.cursor) params.set("cursor", options.cursor);
	if (options.limit) params.set("limit", String(options.limit));
	const query = params.toString();
	return query ? `?${query}` : "";
}

export function createAssetsClient(request: JsonRequest): AssetsClient {
	const list = (options: ListAssetsOptions = {}) => request<AssetListing>(`/v1/assets${assetListQuery(options)}`);
	return {
		list,
		async *listAll(options = {}) {
			let cursor: string | undefined;
			do {
				const page = await list({ ...options, cursor });
				yield* page.objects;
				cursor = page.cursor ?? undefined;
			} while (cursor);
		},
	};
}
