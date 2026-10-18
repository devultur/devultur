// Response for an already-authorized R2 object: L4 decryption (via stream or block-aligned range), `Range`, and the
// integrity/TTL headers. Shared by delivery (`GET /v1/media/*`) and download-link redemption.
import {
	AES_BLOCK_BYTES,
	createDecryptStream,
	decodeEncryptionMeta,
	decryptChunk,
	EXPIRES_AT_HEADER,
	REPR_DIGEST_HEADER,
	reprDigest,
	SHA256_HEADER,
	SHA256_VERIFIED_HEADER,
} from "@devultur/core";
import { loadStorageKey } from "../helpers";
import { ObjectMeta } from "./upload-integrity";

/** Has the object expired (TTL)? From then on we respond 410 even if the sweeper hasn't deleted it yet. Pure. */
export function isObjectExpired(customMetadata: Record<string, string> | undefined, now = Date.now()): boolean {
	const expiresAt = Number(customMetadata?.[ObjectMeta.EXPIRES_AT]);
	return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
}

export function expiredResponse(): Response {
	return Response.json({ error: "This file has expired", code: "expired" }, { status: 410 });
}

/** `x-devultur-sha256`, `Repr-Digest` (RFC 9530), whether the worker verified the sha256, and the expiration. */
export function applyIntegrityHeaders(headers: Headers, customMetadata: Record<string, string> | undefined): void {
	const sha256 = customMetadata?.[ObjectMeta.SHA256];
	if (sha256) {
		headers.set(SHA256_HEADER, sha256);
		headers.set(REPR_DIGEST_HEADER, reprDigest(sha256));
		headers.set(SHA256_VERIFIED_HEADER, customMetadata?.[ObjectMeta.SHA256_VERIFIED] === "true" ? "true" : "false");
	}
	const expiresAt = customMetadata?.[ObjectMeta.EXPIRES_AT];
	if (expiresAt) headers.set(EXPIRES_AT_HEADER, expiresAt);
}

// `bytes=a-b`, `bytes=a-`, or suffix `bytes=-n` (the last n bytes). null = not satisfiable → 416.
export function parseRange(range: string, totalSize: number): [number, number] | null {
	const match = range.match(/bytes=(\d*)-(\d*)/);
	if (!match || (!match[1] && !match[2])) return [0, totalSize - 1];

	if (!match[1]) {
		const suffixLength = Number.parseInt(match[2], 10);
		if (suffixLength === 0) return null;
		return [Math.max(0, totalSize - suffixLength), totalSize - 1];
	}

	const start = Number.parseInt(match[1], 10);
	if (start >= totalSize) return null;
	const end = match[2] ? Math.min(Number.parseInt(match[2], 10), totalSize - 1) : totalSize - 1;
	return end < start ? null : [start, end];
}

export interface StreamObjectInput {
	bucket: R2Bucket;
	keysBucket: R2Bucket | undefined;
	fullKey: string;
	object: R2ObjectBody;
	/** Base headers (content-type, cache-control, disposition…): filled in here. */
	headers: Headers;
	range: string | undefined;
}

/** `plain-*` = unencrypted: public delivery can cache it at the edge. */
export type StreamedKind = "plain-full" | "plain-range" | "other";

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

async function rangeResponse(input: StreamObjectInput, cryptoKey: CryptoKey | null, iv: Uint8Array | null) {
	const { bucket, fullKey, object, headers } = input;
	// CTR preserves length → `object.size` (ciphertext) == plaintext length, so the requested range maps
	// 1:1. To decrypt we align to the 16-byte block: fetch the ciphertext starting at the range's first block,
	// decrypt with THAT block's counter, and trim the excess.
	const byteRange = parseRange(input.range ?? "", object.size);
	if (!byteRange) {
		return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${object.size}` } });
	}
	const [start, end] = byteRange;
	headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
	headers.set("Content-Length", String(end - start + 1));

	if (cryptoKey && iv) {
		const firstBlock = Math.floor(start / AES_BLOCK_BYTES);
		const alignedOffset = firstBlock * AES_BLOCK_BYTES;
		const cipherPart = await bucket.get(fullKey, { range: { offset: alignedOffset, length: end - alignedOffset + 1 } });
		if (!cipherPart) return notFound();
		const decrypted = await decryptChunk(await cipherPart.arrayBuffer(), cryptoKey, iv, firstBlock);
		const leading = start - alignedOffset;
		return new Response(decrypted.subarray(leading, leading + (end - start + 1)), { status: 206, headers });
	}

	const partial = await bucket.get(fullKey, { range: { offset: start, length: end - start + 1 } });
	if (!partial) return notFound();
	return new Response(partial.body, { status: 206, headers });
}

/** Serves the object (decrypted if L4), with `Range` if the request asks for it. */
export async function streamObject(input: StreamObjectInput): Promise<{ response: Response; kind: StreamedKind }> {
	const { object, headers } = input;
	headers.set("Content-Length", String(object.size));
	headers.set("ETag", object.httpEtag);
	headers.set("Accept-Ranges", "bytes");
	applyIntegrityHeaders(headers, object.customMetadata);

	// L4: the key lives at `${fullKey}/${keyId}` → same storage key as the object. No key → 500 (we never leak ciphertext).
	const enc = decodeEncryptionMeta(object.customMetadata?.enc);
	const loaded = enc ? await loadStorageKey(input.keysBucket, input.fullKey, enc.keyId) : null;
	if (enc && !loaded) {
		return { response: Response.json({ error: "Decryption key unavailable" }, { status: 500 }), kind: "other" };
	}
	const cryptoKey = loaded?.key ?? null;
	const iv = enc?.iv ?? null;

	if (input.range && object.size > 0) {
		const response = await rangeResponse(input, cryptoKey, iv);
		return { response, kind: !enc && response.status === 206 ? "plain-range" : "other" };
	}
	if (cryptoKey && iv && object.body) {
		// Streaming: we decrypt in block-aligned chunks → bounded memory for large files.
		return {
			response: new Response(object.body.pipeThrough(createDecryptStream(cryptoKey, iv)), { status: 200, headers }),
			kind: "other",
		};
	}
	return { response: new Response(object.body, { status: 200, headers }), kind: "plain-full" };
}
