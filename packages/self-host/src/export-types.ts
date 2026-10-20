// Types for private exports (upload tokens scoped to a prefix).
import type { ObjectLock, Visibility } from "@devultur/core";

/** What an upload token allows (claims `res`, `visibility`, `max_bytes`, `max_files`, `file_ttl`, `lock`). */
export interface UploadGrant {
	/** Token's `jti`: best-effort counter for `maxFiles`. */
	tokenId: string;
	/** Prefix relative to the storage prefix, without visibility, with a trailing `/` (`asset/exports/inst-1/`). */
	pathPrefix: string;
	visibility: Visibility;
	maxBytes?: number;
	maxFiles?: number;
	/** TTL (seconds) of each file uploaded with the token. */
	fileExpiresIn?: number;
	/** Lock every file uploaded with the token gets at least (a request can make it stricter, never looser). */
	lock?: ObjectLock;
}
