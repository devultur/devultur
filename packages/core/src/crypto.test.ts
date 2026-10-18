import { describe, expect, it } from "vitest";
import {
	counterForBlock,
	createDecryptStream,
	decodeEncryptionMeta,
	decryptChunk,
	encodeEncryptionMeta,
	encryptBytes,
	exportEncryptionKey,
	generateEncryptionKey,
	generateIv,
	importEncryptionKey,
} from "./crypto";

function bytes(length: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) out[i] = (i * 37 + 11) % 256;
	return out;
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.length;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

describe("encrypt/decrypt round-trip", () => {
	it("decrypts exactly what was encrypted (length not a multiple of 16)", async () => {
		const key = await generateEncryptionKey();
		const iv = generateIv();
		const plaintext = bytes(1000); // 62.5 blocks → forces the last partial one
		const ciphertext = await encryptBytes(plaintext, key, iv);
		expect(ciphertext.length).toBe(plaintext.length); // CTR adds no padding
		expect(Array.from(ciphertext)).not.toEqual(Array.from(plaintext));
		const decrypted = await decryptChunk(ciphertext, key, iv, 0);
		expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
	});

	it("the exported/reimported key decrypts the same", async () => {
		const key = await generateEncryptionKey();
		const iv = generateIv();
		const plaintext = bytes(64);
		const ciphertext = await encryptBytes(plaintext, key, iv);
		const reimported = await importEncryptionKey(await exportEncryptionKey(key));
		expect(Array.from(await decryptChunk(ciphertext, reimported, iv, 0))).toEqual(Array.from(plaintext));
	});
});

describe("counterForBlock (Range / seek)", () => {
	it("decrypting from a mid-stream block matches the plaintext range", async () => {
		const key = await generateEncryptionKey();
		const iv = generateIv();
		const plaintext = bytes(512); // 32 blocks
		const ciphertext = await encryptBytes(plaintext, key, iv);

		// Plaintext range [160, 271] → first block = 10 (byte 160), aligned.
		const startBlock = 10;
		const offset = startBlock * 16;
		const chunk = ciphertext.subarray(offset, 272);
		const decrypted = await decryptChunk(chunk, key, iv, startBlock);
		expect(Array.from(decrypted)).toEqual(Array.from(plaintext.subarray(offset, 272)));
	});

	it("increments only the low 64 bits and carries between bytes", () => {
		const iv = new Uint8Array(16).fill(0);
		iv[15] = 0xff;
		const next = counterForBlock(iv, 1);
		expect(next[15]).toBe(0x00);
		expect(next[14]).toBe(0x01);
		// The high 64 bits (nonce) are untouched.
		expect(Array.from(next.subarray(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
	});
});

describe("createDecryptStream", () => {
	it("decrypts in streaming fashion across arbitrary chunks (including a mid-block split)", async () => {
		const key = await generateEncryptionKey();
		const iv = generateIv();
		const plaintext = bytes(1000);
		const ciphertext = await encryptBytes(plaintext, key, iv);

		// Emits the ciphertext in irregular chunks (7, 100, 893) to force alignment buffering.
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(ciphertext.subarray(0, 7));
				controller.enqueue(ciphertext.subarray(7, 107));
				controller.enqueue(ciphertext.subarray(107));
				controller.close();
			},
		});

		const decrypted = await collectStream(source.pipeThrough(createDecryptStream(key, iv)));
		expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
	});
});

describe("envelope meta", () => {
	it("encode → decode round-trip (iv + keyId)", () => {
		const iv = generateIv();
		const encoded = encodeEncryptionMeta(iv, "key-123");
		const decoded = decodeEncryptionMeta(encoded);
		expect(decoded?.keyId).toBe("key-123");
		expect(Array.from(decoded?.iv ?? [])).toEqual(Array.from(iv));
	});

	it("object with no envelope → null (not encrypted)", () => {
		expect(decodeEncryptionMeta(undefined)).toBeNull();
		expect(decodeEncryptionMeta("no-json")).toBeNull();
		expect(decodeEncryptionMeta(JSON.stringify({ alg: "OTHER" }))).toBeNull();
	});
});
