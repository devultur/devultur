// Types for private exports (upload tokens scoped to a prefix).
import type { Visibility } from "@devultur/core";

/** What an upload token allows (claims `res`, `visibility`, `max_bytes`, `max_files`, `file_ttl`). */
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
}
