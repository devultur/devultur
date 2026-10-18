// R2 for the Worker path with transparent L4: read the header or the whole original (decrypted) and store
// derived content (variants and mezzanine) with the same encryption semantics as the original.
import { decodeEncryptionMeta, decryptChunk } from "@devultur/core";
import { encryptForStorage, loadStorageKey } from "../helpers";
import type { WorkerEnv } from "../types";

// What gets downloaded to read dimensions and animation without fetching the whole file. A JPEG's SOF can come after
// an EXIF (≤ 64 KB) and ICC profiles across several APP2 segments → 256 KB covers the real-world cases.
const HEADER_PROBE_BYTES = 256 * 1024;

export type Decrypt = (bytes: Uint8Array<ArrayBuffer>) => Promise<Uint8Array<ArrayBuffer>>;

const passThrough: Decrypt = async (bytes) => bytes;

export const DerivedKind = {
	VARIANT: "variant",
	MEZZANINE: "mezzanine",
} as const;

export type DerivedKind = (typeof DerivedKind)[keyof typeof DerivedKind];

/**
 * Object decryptor: identity if not encrypted, AES-CTR from block 0 if it's L4 (works the same for a
 * prefix as for the whole file). Null = encrypted but no key → the caller falls back to Cloudflare.
 */
export async function loadDecryptor(
	env: WorkerEnv,
	objectKey: string,
	customMetadata: Record<string, string> | undefined,
): Promise<Decrypt | null> {
	const enc = decodeEncryptionMeta(customMetadata?.enc);
	if (!enc) return passThrough;
	const loaded = await loadStorageKey(env.KEYS_BUCKET, objectKey, enc.keyId);
	if (!loaded) return null;
	return (bytes) => decryptChunk(bytes, loaded.key, enc.iv, 0);
}

/** First KB of the object, in plaintext. */
export async function readHeaderBytes(
	env: WorkerEnv,
	objectKey: string,
	object: R2Object,
	decrypt: Decrypt,
): Promise<Uint8Array<ArrayBuffer> | null> {
	const length = Math.min(object.size, HEADER_PROBE_BYTES);
	if (length === 0) return null;
	const part = await env.MEDIA_BUCKET.get(objectKey, { range: { offset: 0, length } });
	if (!part) return null;
	return decrypt(new Uint8Array(await part.arrayBuffer()));
}

/** The whole object, in plaintext. Only called after the guard approved its dimensions. */
export async function readWholeObject(object: R2ObjectBody, decrypt: Decrypt): Promise<Uint8Array<ArrayBuffer>> {
	return decrypt(new Uint8Array(await object.arrayBuffer()));
}

/**
 * Stores a variant or the mezzanine. Inherits from the original: if it's encrypted, the derived content is too (its own
 * key under `${storageKey}/${keyId}` in KEYS_BUCKET, written BEFORE the object → there's never an object without its key)
 * and copies the binding override (`security`) for the gate. An R2 PUT is atomic: two concurrent generations leave one of
 * the two complete (the losing key is orphaned under the prefix and gets swept along with the original).
 */
export async function storeDerived(
	env: WorkerEnv,
	storageKey: string,
	body: ArrayBuffer,
	contentType: string,
	original: R2Object,
	kind: DerivedKind,
): Promise<void> {
	const security = original.customMetadata?.security;
	const customMetadata: Record<string, string> = { derivedFrom: kind };
	if (security) customMetadata.security = security;

	let storedBody: ArrayBuffer | Uint8Array = body;
	if (decodeEncryptionMeta(original.customMetadata?.enc)) {
		if (!env.KEYS_BUCKET) throw new Error("Encrypted original without KEYS_BUCKET");
		const encrypted = await encryptForStorage(env.KEYS_BUCKET, storageKey, body, security ? { security } : undefined);
		storedBody = encrypted.body;
		customMetadata.enc = encrypted.enc;
	}

	await env.MEDIA_BUCKET.put(storageKey, storedBody, {
		storageClass: "Standard",
		httpMetadata: { contentType },
		customMetadata,
	});
}
