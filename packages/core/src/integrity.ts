// File integrity: sha256 of the PLAINTEXT (before L4 encryption), which the worker stores in the object's
// metadata and returns on GET/HEAD. Headers and helpers shared by the SDK and the worker.

/** sha256 (hex) of the file: the client declares it on upload and the worker returns it on GET/HEAD. */
export const SHA256_HEADER = "x-devultur-sha256";
/** `true` = the worker computed the sha256 over the bytes; `false` = the client declared it (multipart). */
export const SHA256_VERIFIED_HEADER = "x-devultur-sha256-verified";
/** File expiration (epoch ms) if it was uploaded with a TTL. */
export const EXPIRES_AT_HEADER = "x-devultur-expires-at";
/** RFC 9530: `sha-256=:<base64>:`. */
export const REPR_DIGEST_HEADER = "Repr-Digest";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Normalizes a hex sha256 (lowercase). `null` if it isn't a 64-character hex sha256. */
export function normalizeSha256(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const value = raw.trim().toLowerCase();
	return SHA256_HEX.test(value) ? value : null;
}

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** sha256 hex of a buffer (WebCrypto: Workers, browser, and Node ≥ 18). Loads everything into memory: only small parts/files. */
export async function sha256Hex(data: BufferSource): Promise<string> {
	return bytesToHex(await crypto.subtle.digest("SHA-256", data));
}

/** `Repr-Digest` value (RFC 9530) for a hex sha256: `sha-256=:<base64>:`. */
export function reprDigest(sha256: string): string {
	const pairs = sha256.match(/.{2}/g) ?? [];
	const binary = pairs.map((pair) => String.fromCharCode(Number.parseInt(pair, 16))).join("");
	return `sha-256=:${btoa(binary)}:`;
}
