// A download grant's secret and public id. Both name the file's `DownloadGrants` instance (its Durable Object id, a
// 64-hex hash that says where the grant lives, not what it opens) and the grant within it:
// - secret: `dvg_<objectId>.<grantId>.<secret>`, 128-bit grant id and 256-bit secret, base64url. Only its SHA-256 is
//   stored.
// - public id: `dgr_<objectId>.<grantId>`. Revokes the grant through the owner's credential; grants nothing.
import { DOWNLOAD_GRANT_ID_PREFIX, DOWNLOAD_GRANT_PREFIX } from "@devultur/core";
import { hashKey } from "./helpers";

export interface GrantLocation {
	/** Durable Object id of the file's `DownloadGrants`. */
	objectId: string;
	grantId: string;
}

export interface ParsedGrantSecret extends GrantLocation {
	secret: string;
}

const OBJECT_ID = "[0-9a-f]{64}";
const GRANT_ID = "[A-Za-z0-9_-]{22}";
const SECRET = "[A-Za-z0-9_-]{43}";
const SECRET_PATTERN = new RegExp(`^${DOWNLOAD_GRANT_PREFIX}(${OBJECT_ID})\\.(${GRANT_ID})\\.(${SECRET})$`);
const PUBLIC_ID_PATTERN = new RegExp(`^${DOWNLOAD_GRANT_ID_PREFIX}(${OBJECT_ID})\\.(${GRANT_ID})$`);

/** `bytes` random bytes as base64url, without padding. */
export function randomBase64Url(bytes: number): string {
	const random = crypto.getRandomValues(new Uint8Array(bytes));
	return btoa(String.fromCharCode(...random))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export const newGrantId = () => randomBase64Url(16);
export const newGrantSecret = () => randomBase64Url(32);

export function formatGrantSecret({ objectId, grantId, secret }: ParsedGrantSecret): string {
	return `${DOWNLOAD_GRANT_PREFIX}${objectId}.${grantId}.${secret}`;
}

export function formatGrantPublicId({ objectId, grantId }: GrantLocation): string {
	return `${DOWNLOAD_GRANT_ID_PREFIX}${objectId}.${grantId}`;
}

/** The parts of a grant's secret, or null if it isn't one. Pure. */
export function parseGrantSecret(value: string): ParsedGrantSecret | null {
	const match = SECRET_PATTERN.exec(value);
	return match ? { objectId: match[1], grantId: match[2], secret: match[3] } : null;
}

/** The parts of a grant's public id, or null if it isn't one. Pure. */
export function parseGrantPublicId(value: string): GrantLocation | null {
	const match = PUBLIC_ID_PATTERN.exec(value);
	return match ? { objectId: match[1], grantId: match[2] } : null;
}

/** What the `DownloadGrants` object stores of a secret. */
export const hashGrantSecret = (secret: string) => hashKey(secret);
