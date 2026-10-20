import {
	decodeEncryptionMeta,
	decryptChunk,
	importEncryptionKey,
	MULTIPART_PART_SIZE_BYTES,
	type SecurityPolicy,
} from "@devultur/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { updateRequestState } from "../request-state";
import type { WorkerApp } from "../types";
import { upload } from "./upload";
import { expectedPartBytes, normalizeCompletedParts } from "./upload-multipart";

const KEY = "private/video/vid1/raw/clip.mp4";
const STORAGE_KEY = `prefix-a/${KEY}`;
const PART = MULTIPART_PART_SIZE_BYTES;
// The pending's id, carried by the upload URL (`?u=…`); the pending lives in KV under it, not under the key.
const PENDING_ID = "pendingIdpendingIdpend";
const PENDING_KV = `upload-pending:${PENDING_ID}`;

interface StoredMultipart {
	key: string;
	options: R2MultipartOptions | undefined;
	parts: Map<number, Uint8Array>;
	isAborted: boolean;
}

// In-memory R2 with the multipart API (create/resume → uploadPart/complete/abort) + the pending's KV.
interface SetupOptions {
	pending?: Record<string, unknown>;
	legacyPending?: Record<string, unknown>;
	security?: SecurityPolicy;
	/** Simulates a concurrent create that writes ITS session right after ours. */
	concurrentUploadId?: string;
}

function setup(options: SetupOptions = {}) {
	const kv = new Map<string, string>();
	if (options.pending) kv.set(PENDING_KV, JSON.stringify({ key: KEY, ...options.pending }));
	// Pending in the previous shape (KV keyed by the key, no id): no longer authorizes anything.
	if (options.legacyPending) kv.set(`upload-pending:${KEY}`, JSON.stringify(options.legacyPending));
	const uploads = new Map<string, StoredMultipart>();
	const objects = new Map<string, { bytes: Uint8Array; options: R2MultipartOptions | undefined }>();
	const keys = new Map<string, ArrayBuffer>();

	const resume = (key: string, uploadId: string) => {
		const stored = uploads.get(uploadId);
		return {
			uploadPart: async (partNumber: number, value: ArrayBuffer | Uint8Array) => {
				stored?.parts.set(partNumber, new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value)));
				return { partNumber, etag: `etag-${partNumber}` };
			},
			complete: async (parts: Array<{ partNumber: number }>) => {
				const chunks = parts.map((part) => stored?.parts.get(part.partNumber) ?? new Uint8Array());
				const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.length;
				}
				objects.set(key, { bytes, options: stored?.options });
				return { size: bytes.length };
			},
			abort: async () => {
				if (stored) stored.isAborted = true;
			},
		};
	};

	const env = {
		MEDIA_KV: {
			get: async (key: string) => kv.get(key) ?? null,
			put: async (key: string, value: string) => {
				const written = JSON.parse(value) as { multipart?: { uploadId: string } };
				const isOurSession = written.multipart && written.multipart.uploadId !== options.concurrentUploadId;
				if (options.concurrentUploadId && isOurSession) {
					const winner = { ...written, multipart: { ...written.multipart, uploadId: options.concurrentUploadId } };
					kv.set(key, JSON.stringify(winner));
					return;
				}
				kv.set(key, value);
			},
			delete: async (key: string) => void kv.delete(key),
		},
		MEDIA_BUCKET: {
			// Empty bucket: the lock check finds nothing to overwrite.
			head: async () => null,
			createMultipartUpload: async (key: string, multipartOptions?: R2MultipartOptions) => {
				const uploadId = `up-${uploads.size + 1}`;
				uploads.set(uploadId, { key, options: multipartOptions, parts: new Map(), isAborted: false });
				return { uploadId, key, ...resume(key, uploadId) };
			},
			resumeMultipartUpload: resume,
		},
		KEYS_BUCKET: {
			put: async (path: string, body: Uint8Array) => void keys.set(path, body.slice().buffer),
			get: async (path: string) => {
				const stored = keys.get(path);
				return stored ? { arrayBuffer: async () => stored, customMetadata: undefined } : null;
			},
		},
	} as unknown as WorkerApp["Bindings"];

	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		updateRequestState(context, { storagePrefix: "prefix-a/" });
		if (options.security) updateRequestState(context, { config: { security: options.security } });
		await next();
	});
	app.route("/v1/upload", upload);

	// `path` is the multipart protocol's query, added to the upload URL's (`?u=<id>`).
	const requestWith = (pendingQuery: string, path: string, init: RequestInit) =>
		app.request(
			`http://worker/v1/upload/${KEY}${pendingQuery}${path.replace(/^\?/, pendingQuery ? "&" : "?")}`,
			init,
			env,
		);
	const request = (path: string, init: RequestInit) => requestWith(`?u=${PENDING_ID}`, path, init);
	const create = (size: number) => request("?multipart=create", { method: "POST", body: JSON.stringify({ size }) });
	const putPart = (uploadId: string, partNumber: number, bytes: Uint8Array<ArrayBuffer>) =>
		request(`?uploadId=${uploadId}&partNumber=${partNumber}`, { method: "PUT", body: bytes });
	const complete = (uploadId: string, parts: unknown) =>
		request("?multipart=complete", { method: "POST", body: JSON.stringify({ uploadId, parts }) });

	return { request, requestWith, create, putPart, complete, kv, uploads, objects, keys };
}

function basePending(extra: Record<string, unknown> = {}) {
	return { contentType: "video/mp4", storageKey: STORAGE_KEY, originalFilename: "clip.mp4", ...extra };
}

function hasSameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	return a.every((byte, index) => byte === b[index]);
}

function bytes(length: number, seed = 7): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) % 256;
	return out;
}

describe("multipart upload routes", () => {
	it("requires the pending capability (no pending → 404, nothing created in R2)", async () => {
		const { create, uploads } = setup();
		const res = await create(PART + 10);
		expect(res.status).toBe(404);
		expect(uploads.size).toBe(0);
	});

	it("rejects a declared size above the pending's max before touching R2", async () => {
		const { create, uploads } = setup({ pending: basePending({ maxSizeBytes: PART }) });
		const res = await create(PART + 1);
		expect(res.status).toBe(413);
		expect(await res.json()).toMatchObject({ code: "file_too_large", limit: PART });
		expect(uploads.size).toBe(0);
	});

	it("uploads exact-size parts and completes into the storage-prefixed object", async () => {
		const { create, putPart, complete, objects, kv, uploads } = setup({ pending: basePending() });
		const created = await create(PART + 100);
		expect(await created.json()).toEqual({ uploadId: "up-1", partSize: PART, partCount: 2 });
		expect(uploads.get("up-1")?.options?.httpMetadata).toMatchObject({ contentType: "video/mp4" });

		const tooShort = await putPart("up-1", 1, bytes(10));
		expect(tooShort.status).toBe(400);

		const plaintext = bytes(PART + 100);
		const first = await putPart("up-1", 1, plaintext.slice(0, PART));
		const second = await putPart("up-1", 2, plaintext.slice(PART));
		expect(await first.json()).toEqual({ partNumber: 1, etag: "etag-1" });
		expect(second.status).toBe(200);

		const done = await complete("up-1", [
			{ partNumber: 2, etag: "etag-2" },
			{ partNumber: 1, etag: "etag-1" },
		]);
		expect(await done.json()).toEqual({ key: KEY, size: PART + 100 });
		expect(objects.get(STORAGE_KEY)?.bytes.length).toBe(PART + 100);
		expect(kv.has(PENDING_KV)).toBe(false);
	});

	it("keeps only the plugin's own keys of the pending's uploadMetadata", async () => {
		const { create, uploads } = setup({
			pending: basePending({
				uploadMetadata: {
					team: "a",
					sha256: "forged",
					sha256Verified: "true",
					enc: "forged",
					security: JSON.stringify({ sessionBinding: false }),
					ExpiresAt: "1",
				},
			}),
		});
		expect((await create(PART + 100)).status).toBe(200);
		expect(uploads.get("up-1")?.options?.customMetadata).toEqual({ team: "a" });
	});

	it("rejects a part for another uploadId", async () => {
		const { create, putPart } = setup({ pending: basePending() });
		await create(PART + 100);
		const res = await putPart("forged", 2, bytes(100));
		expect(res.status).toBe(404);
	});

	it("encrypts each part at its CTR offset so the whole object decrypts like a single PUT", async () => {
		const { create, putPart, complete, objects, keys } = setup({
			pending: basePending({ security: { encrypt: true } }),
			security: { encrypt: true },
		});
		await create(PART + 100);
		const plaintext = bytes(PART + 100, 3);
		await putPart("up-1", 1, plaintext.slice(0, PART));
		await putPart("up-1", 2, plaintext.slice(PART));
		await complete("up-1", [
			{ partNumber: 1, etag: "etag-1" },
			{ partNumber: 2, etag: "etag-2" },
		]);

		const stored = objects.get(STORAGE_KEY);
		const meta = decodeEncryptionMeta(stored?.options?.customMetadata?.enc);
		expect(meta).not.toBeNull();
		const rawKey = keys.get(`${STORAGE_KEY}/${meta?.keyId}`) as ArrayBuffer;
		const cryptoKey = await importEncryptionKey(rawKey);
		const decrypted = await decryptChunk(
			stored?.bytes as Uint8Array<ArrayBuffer>,
			cryptoKey,
			meta?.iv as Uint8Array,
			0,
		);
		expect(hasSameBytes(decrypted, plaintext)).toBe(true);
	});

	it("aborts the R2 upload and drops the pending", async () => {
		const { create, request, uploads, kv } = setup({ pending: basePending() });
		await create(PART + 100);
		const res = await request("?uploadId=up-1", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(uploads.get("up-1")?.isAborted).toBe(true);
		expect(kv.has(PENDING_KV)).toBe(false);
	});
});

describe("multipart pending id", () => {
	const createWith = (requestWith: ReturnType<typeof setup>["requestWith"], pendingQuery: string) =>
		requestWith(pendingQuery, "?multipart=create", { method: "POST", body: JSON.stringify({ size: PART + 100 }) });

	it("a retried create without the pending id gets 404, never the existing uploadId", async () => {
		const { create, requestWith } = setup({ pending: basePending() });
		expect(await (await create(PART + 100)).json()).toMatchObject({ uploadId: "up-1" });

		for (const pendingQuery of ["", "?u=wrongIdwrongIdwrongId", "?u=short"]) {
			const retried = await createWith(requestWith, pendingQuery);
			expect(retried.status).toBe(404);
			expect(JSON.stringify(await retried.json())).not.toContain("up-1");
		}
		// With the id, the retry does recover its own session.
		expect(await (await create(PART + 100)).json()).toMatchObject({ uploadId: "up-1" });
	});

	it("parts, complete and abort need the pending id too", async () => {
		const { create, requestWith, uploads, objects } = setup({ pending: basePending() });
		await create(PART + 100);
		const part = await requestWith("", "?uploadId=up-1&partNumber=2", { method: "PUT", body: bytes(100) });
		const done = await requestWith("", "?multipart=complete", {
			method: "POST",
			body: JSON.stringify({ uploadId: "up-1", parts: [] }),
		});
		const aborted = await requestWith("?u=wrongIdwrongIdwrongId", "?uploadId=up-1", { method: "DELETE" });
		expect([part.status, done.status, aborted.status]).toEqual([404, 404, 404]);
		expect(uploads.get("up-1")?.parts.size).toBe(0);
		expect(uploads.get("up-1")?.isAborted).toBe(false);
		expect(objects.size).toBe(0);
	});

	it("a pending stored under its key (previous format) no longer authorizes anything", async () => {
		const { requestWith, uploads } = setup({ legacyPending: basePending() });
		expect((await createWith(requestWith, "")).status).toBe(404);
		expect(uploads.size).toBe(0);
	});
});

describe("multipart request validation", () => {
	it("rejects an empty uploadId instead of treating the PUT as a single upload", async () => {
		const { request, objects } = setup({ pending: basePending() });
		for (const query of ["?uploadId=", "?uploadId=up-1", "?partNumber=1"]) {
			const res = await request(query, { method: "PUT", body: bytes(10) });
			expect(res.status).toBe(400);
		}
		expect(objects.size).toBe(0);
	});

	it("aborts its own R2 upload when a concurrent create won the pending", async () => {
		const { create, uploads } = setup({ pending: basePending(), concurrentUploadId: "up-winner" });
		const res = await create(PART + 100);
		expect(await res.json()).toMatchObject({ uploadId: "up-winner" });
		expect(uploads.get("up-1")?.isAborted).toBe(true);
	});
});

describe("multipart plan validation", () => {
	const multipart = { uploadId: "u", size: 250, partSize: 100 };

	it("expects full parts and a shorter last part", () => {
		expect(expectedPartBytes(multipart, 1)).toBe(100);
		expect(expectedPartBytes(multipart, 3)).toBe(50);
		expect(expectedPartBytes(multipart, 4)).toBeNull();
		expect(expectedPartBytes(multipart, 0)).toBeNull();
	});

	it("accepts the complete only with every part exactly once", () => {
		const parts = [1, 2, 3].map((partNumber) => ({ partNumber, etag: `e${partNumber}` }));
		expect(normalizeCompletedParts(multipart, parts)).toEqual(parts);
		expect(normalizeCompletedParts(multipart, parts.slice(0, 2))).toBeNull();
		expect(normalizeCompletedParts(multipart, [parts[0], parts[0], parts[2]])).toBeNull();
	});
});
