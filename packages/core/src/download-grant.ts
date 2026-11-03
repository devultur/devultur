// Download grants: a capability over ONE private file that the owner issues with their credential and hands to another
// system. Its bearer can read the file's head, issue download links within the caps the owner set, delete the file if
// allowed, and revoke the grant. It can't read the bytes itself, list, upload or touch another file. The grant (`dvg_…`)
// travels only in `Authorization: Bearer`, never in a URL; the links it issues carry their own opaque id.

/** Prefix of a grant's secret. */
export const DOWNLOAD_GRANT_PREFIX = "dvg_";
/** Prefix of a grant's public id (to revoke and audit it; not a credential). */
export const DOWNLOAD_GRANT_ID_PREFIX = "dgr_";

/** `HEAD /v1/grant/file`: whether the file is encrypted at rest (`true`/`false`). */
export const ENCRYPTED_HEADER = "x-devultur-encrypted";
/** `HEAD /v1/grant/file`: when the grant expires (epoch ms). */
export const GRANT_EXPIRES_AT_HEADER = "x-devultur-grant-expires-at";
/** `HEAD /v1/grant/file`: the key of the grant's file. */
export const GRANT_KEY_HEADER = "x-devultur-grant-key";
/** `HEAD /v1/grant/file`: the grant's metadata, as URI-encoded JSON. */
export const GRANT_METADATA_HEADER = "x-devultur-grant-metadata";

export const DownloadGrantLimits = {
	/** Longest grant lifetime of a file without a TTL. A file with one: its `expiresAt`. */
	MAX_LIFETIME_SECONDS: 30 * 24 * 60 * 60,
	DEFAULT_LINK_EXPIRES_IN: 900,
	MAX_LINK_EXPIRES_IN: 86_400,
	DEFAULT_LINK_MAX_USES: 1,
	MAX_LINK_MAX_USES: 10,
	DEFAULT_MAX_LINKS: 20,
	MAX_MAX_LINKS: 100,
	/** Size of the metadata as JSON, in UTF-8 bytes. */
	MAX_METADATA_BYTES: 1024,
} as const;

export const DownloadGrantErrorCode = {
	/** Unknown, malformed or not this Worker's grant. */
	INVALID: "invalid_grant",
	/** Expired, revoked, or its file is gone. */
	GONE: "grant_gone",
	/** It issued all of its links. */
	EXHAUSTED: "grant_exhausted",
	/** A link above `link.maxExpiresIn` or `link.maxUses`. */
	LINK_EXCEEDS_GRANT: "link_exceeds_grant",
	/** The grant was sent in `?token=`. */
	IN_QUERY: "grant_in_query",
	/** `delete()` on a grant issued without `canDelete`. */
	CANNOT_DELETE: "grant_cannot_delete",
	NOT_FOUND: "grant_not_found",
} as const;

export interface DownloadGrantLinkCaps {
	/** Longest `expiresIn` (seconds) of each link. */
	maxExpiresIn: number;
	/** Most `maxUses` of each link. */
	maxUses: number;
}

export interface CreateDownloadGrantOptions {
	/** Grant lifetime in seconds. Default and cap: the file's `expiresAt`; without a TTL, 30 days. */
	expiresIn?: number;
	/** Caps of every link the grant issues. Default `{ maxExpiresIn: 900, maxUses: 1 }`. */
	link?: Partial<DownloadGrantLinkCaps>;
	/** Links the grant may issue in total (default 20, max 100). */
	maxLinks?: number;
	/** Allows `delete()` (default false). Needs a credential that can delete the file. */
	canDelete?: boolean;
	/** Opaque string → string metadata (≤ 1 KB as JSON), returned by `head()` and stored with every link. */
	metadata?: Record<string, string>;
}

/** A grant as listed: everything but its secret. */
export interface DownloadGrantSummary {
	/** Public id (`dgr_…`): revokes and identifies the grant, grants nothing. */
	id: string;
	key: string;
	/** Epoch ms. */
	expiresAt: number;
	link: DownloadGrantLinkCaps;
	maxLinks: number;
	canDelete: boolean;
	metadata?: Record<string, string>;
}

export interface DownloadGrant extends DownloadGrantSummary {
	/** The secret (`dvg_…`). Returned once. */
	grant: string;
}

export interface DownloadGrantListEntry extends DownloadGrantSummary {
	linksIssued: number;
	/** Epoch ms. */
	createdAt: number;
	/** Epoch ms, or null while live. */
	revokedAt: number | null;
}

/** Is `value` shaped like a grant's secret? Pure. */
export function isDownloadGrant(value: string): boolean {
	return value.startsWith(DOWNLOAD_GRANT_PREFIX);
}
