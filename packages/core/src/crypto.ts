// L4 — at-rest encryption of private assets (image/file). AES-CTR chosen deliberately over GCM: the
// Worker has ~128MB of RAM and whole-file GCM rules out large files; CTR is seekable (Range) and
// streamable with bounded memory, giving the SAME confidentiality (the actual goal). Crypto
// integrity remains a future upgrade (chunked-GCM) — additive thanks to the versioned envelope.
//
// Encryption envelope: instead of a header inside the body (which throws off Content-Length and
// forces fragile offsets on every Range), the envelope lives in the R2 object's metadata:
//   enc = { "v": 1, "alg": "AES-CTR", "iv": "<base64 16B>", "keyId": "<id>" }
// The body stays as pure ciphertext (same length as the plaintext) → Range maps 1:1, and migrating to
// another mode later is additive (bump `v`). The key material does NOT go here: it lives in the key bucket.

/** Current encryption mode. Versioned: upgrading to chunked-GCM later is additive (new `v` value). */
export const ENCRYPTION_VERSION = 1;
export const ENCRYPTION_ALG = "AES-CTR";

/** Size of the AES block and the CTR counter (bytes). The IV IS the initial counter block. */
export const AES_BLOCK_BYTES = 16;
/** Counter bits within the 128-bit block (the low 64 increment per block). */
const CTR_LENGTH_BITS = 64;

export interface EncryptionMeta {
	/** Envelope version (for additive mode migration). */
	v: number;
	/** Algorithm. Always AES-CTR today. */
	alg: string;
	/** Initial counter (IV) in base64, 16 bytes. */
	iv: string;
	/** Id of the key in the key bucket (enables additive rotation). */
	keyId: string;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Generates a 256-bit AES-CTR key, extractable (to persist it in the key bucket). */
export function generateEncryptionKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: "AES-CTR", length: 256 }, true, ["encrypt", "decrypt"]);
}

/** Serializes the key's (raw) material to store it in the key bucket. */
export async function exportEncryptionKey(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

/** Reconstructs the CryptoKey from its raw material (read from the key bucket at delivery). */
export function importEncryptionKey(raw: BufferSource): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", raw, { name: "AES-CTR" }, false, ["encrypt", "decrypt"]);
}

/** Random IV (16 bytes) = this object's initial counter block. Unique per object. */
export function generateIv(): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(AES_BLOCK_BYTES));
}

// Counter for block `blockIndex`: increments the IV's low 64 bits (big-endian) by the index.
// WebCrypto (length=64) treats the high 64 bits as a fixed nonce and the low bits as the counter,
// so we only touch bytes 8..15. This enables Range and chunked decrypt: each chunk starts at
// its first block's counter.
export function counterForBlock(iv: Uint8Array, blockIndex: number): Uint8Array<ArrayBuffer> {
	const counter = new Uint8Array(iv);
	let remaining = blockIndex;
	for (let i = AES_BLOCK_BYTES - 1; i >= 8 && remaining > 0; i--) {
		const sum = counter[i] + (remaining % 256);
		counter[i] = sum & 0xff;
		remaining = Math.floor(remaining / 256) + (sum > 0xff ? 1 : 0);
	}
	return counter;
}

/** Encrypts plaintext with AES-CTR from the given `iv`. One-shot (the upload already has the full body). */
export async function encryptBytes(
	plaintext: BufferSource,
	key: CryptoKey,
	iv: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	const buffer = await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv, length: CTR_LENGTH_BITS }, key, plaintext);
	return new Uint8Array(buffer);
}

/**
 * Decrypts a ciphertext chunk whose FIRST byte falls on `startBlockIndex` (block-aligned). CTR is
 * symmetric (encrypt == decrypt); WebCrypto accepts non-multiple-of-16 lengths in the last chunk.
 * Used for Range (one aligned chunk per request) and for the stream's last partial block.
 */
export async function decryptChunk(
	ciphertext: BufferSource,
	key: CryptoKey,
	iv: Uint8Array,
	startBlockIndex: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const counter = counterForBlock(iv, startBlockIndex);
	const buffer = await crypto.subtle.decrypt({ name: "AES-CTR", counter, length: CTR_LENGTH_BITS }, key, ciphertext);
	return new Uint8Array(buffer);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

/**
 * TransformStream that decrypts AES-CTR ciphertext at delivery with bounded memory (for large
 * objects). Buffers until aligned to 16 bytes, decrypts the full block while keeping the counter
 * running, and carries the remainder (<16B) over to the next chunk. The last partial chunk is
 * decrypted in flush. The caller plugs it into `object.body` → the client receives plaintext.
 */
export function createDecryptStream(key: CryptoKey, iv: Uint8Array): TransformStream<Uint8Array, Uint8Array> {
	let blockIndex = 0;
	let remainder: Uint8Array<ArrayBuffer> = new Uint8Array(0);
	return new TransformStream<Uint8Array, Uint8Array>({
		async transform(chunk, controller) {
			const combined = concat(remainder, chunk);
			const alignedLength = combined.length - (combined.length % AES_BLOCK_BYTES);
			if (alignedLength > 0) {
				const plain = await decryptChunk(combined.subarray(0, alignedLength), key, iv, blockIndex);
				controller.enqueue(plain);
				blockIndex += alignedLength / AES_BLOCK_BYTES;
			}
			remainder = combined.subarray(alignedLength);
		},
		async flush(controller) {
			if (remainder.length > 0) {
				controller.enqueue(await decryptChunk(remainder, key, iv, blockIndex));
			}
		},
	});
}

/** Envelope → string for the R2 object's custom metadata. */
export function encodeEncryptionMeta(iv: Uint8Array, keyId: string): string {
	const meta: EncryptionMeta = { v: ENCRYPTION_VERSION, alg: ENCRYPTION_ALG, iv: toBase64(iv), keyId };
	return JSON.stringify(meta);
}

/** Reads the envelope from the metadata. Returns null if the object isn't encrypted or the envelope is invalid. */
export function decodeEncryptionMeta(raw: string | undefined): { iv: Uint8Array; keyId: string } | null {
	if (!raw) return null;
	try {
		const meta = JSON.parse(raw) as EncryptionMeta;
		if (meta.alg !== ENCRYPTION_ALG || !meta.iv || !meta.keyId) return null;
		return { iv: fromBase64(meta.iv), keyId: meta.keyId };
	} catch {
		return null;
	}
}
