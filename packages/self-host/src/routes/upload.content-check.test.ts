import { MULTIPART_PART_SIZE_BYTES } from "@devultur/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type ContentSniffingMode, updateRequestState } from "../request-state";
import type { WorkerApp } from "../types";
import { upload } from "./upload";

const PART = MULTIPART_PART_SIZE_BYTES;
const PDF = new TextEncoder().encode("%PDF-1.7\n%âã\n1 0 obj\n");
const HTML = new TextEncoder().encode("<!doctype html><script>alert(document.cookie)</script>");
// An MP4's `ftyp` box.
const MP4_HEAD = new Uint8Array([0, 0, 0, 16, ...new TextEncoder().encode("ftypisom"), 0, 0, 2, 0]);

function withHead(head: Uint8Array, length: number): Uint8Array<ArrayBuffer> {
	const part = new Uint8Array(length);
	part.set(head.subarray(0, length));
	return part;
}

interface SetupOptions {
	contentSniffing?: ContentSniffingMode;
	isEncrypted?: boolean;
	isAuthenticated?: boolean;
}

// In-memory R2 (single put, multipart create/resume/abort), KV and keys bucket, with the upload router mounted.
function setup(options: SetupOptions = {}) {
	const kv = new Map<string, string>();
	const objects = new Map<string, { options: R2PutOptions | undefined }>();
	const sessions = new Map<string, { key: string; contentType?: string; isAborted: boolean; parts: number[] }>();
	const keys = new Map<string, ArrayBuffer>();
	const resume = (_key: string, uploadId: string) => {
		const session = sessions.get(uploadId);
		return {
			uploadPart: async (partNumber: number) => {
				session?.parts.push(partNumber);
				return { partNumber, etag: `etag-${partNumber}` };
			},
			complete: async () => ({ size: 0 }),
			abort: async () => {
				if (session) session.isAborted = true;
			},
		};
	};
	const env = {
		MEDIA_KV: {
			get: async (key: string) => kv.get(key) ?? null,
			put: async (key: string, value: string) => void kv.set(key, value),
			delete: async (key: string) => void kv.delete(key),
		},
		MEDIA_BUCKET: {
			head: async () => null,
			list: async () => ({ objects: [] }),
			put: async (key: string, _value: unknown, putOptions?: R2PutOptions) => {
				objects.set(key, { options: putOptions });
				return {};
			},
			createMultipartUpload: async (key: string, multipartOptions?: R2MultipartOptions) => {
				const uploadId = `up-${sessions.size + 1}`;
				const contentType = (multipartOptions?.httpMetadata as R2HTTPMetadata | undefined)?.contentType;
				sessions.set(uploadId, { key, contentType, isAborted: false, parts: [] });
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
			head: async (path: string) => (keys.has(path) ? { key: path } : null),
			delete: async (path: string) => void keys.delete(path),
		},
	};
	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		updateRequestState(context, {
			storagePrefix: "",
			config: {
				...(options.contentSniffing ? { contentSniffing: options.contentSniffing } : {}),
				...(options.isEncrypted ? { security: { encrypt: true } } : {}),
			},
			...(options.isAuthenticated ? { access: { authenticated: true } } : {}),
		});
		await next();
	});
	app.route("/v1/upload", upload);
	const send = (path: string, init: RequestInit) => app.request(path, init, env as never);
	const postJson = (path: string, body: unknown) => send(path, { method: "POST", body: JSON.stringify(body) });

	/** `POST /v1/upload` as a client would: the upload URL that carries the pending. */
	async function createUpload(contentType: string, filename: string, visibility = "public") {
		const res = await postJson("/v1/upload", { filename, contentType, visibility });
		return ((await res.json()) as { key: string; uploadUrl: string }).uploadUrl;
	}
	const put = (url: string, contentType: string, body: Uint8Array<ArrayBuffer>) =>
		send(url, { method: "PUT", headers: { "Content-Type": contentType }, body });
	const createMultipart = async (url: string, size: number, body: Record<string, unknown> = {}) => {
		const res = await postJson(`${url}${url.includes("?") ? "&" : "?"}multipart=create`, { size, ...body });
		return ((await res.json()) as { uploadId: string }).uploadId;
	};
	const putPart = (url: string, uploadId: string, partNumber: number, body: Uint8Array<ArrayBuffer>) =>
		send(`${url}${url.includes("?") ? "&" : "?"}uploadId=${uploadId}&partNumber=${partNumber}`, {
			method: "PUT",
			body,
		});
	const complete = (url: string, uploadId: string, partCount: number) =>
		postJson(`${url}${url.includes("?") ? "&" : "?"}multipart=complete`, {
			uploadId,
			parts: Array.from({ length: partCount }, (_, index) => ({ partNumber: index + 1, etag: `etag-${index + 1}` })),
		});

	return { kv, objects, sessions, keys, createUpload, put, createMultipart, putPart, complete };
}

const storedContentType = (stored: { options: R2PutOptions | undefined } | undefined) =>
	(stored?.options?.httpMetadata as R2HTTPMetadata | undefined)?.contentType;

describe("single PUT content verification", () => {
	it("stores a file whose bytes match its type", async () => {
		const { createUpload, put, objects } = setup();
		const url = await createUpload("application/pdf", "report.pdf");

		expect((await put(url, "application/pdf", withHead(PDF, 64))).status).toBe(200);
		expect(storedContentType([...objects.values()][0])).toBe("application/pdf");
	});

	it("rejects an HTML file declared as a PDF with 415 and stores nothing", async () => {
		const { createUpload, put, objects, kv } = setup();
		const url = await createUpload("application/pdf", "report.pdf");

		const res = await put(url, "application/pdf", withHead(HTML, HTML.length));

		expect(res.status).toBe(415);
		expect(await res.json()).toMatchObject({
			code: "content_type_mismatch",
			declared: "application/pdf",
			detected: "html",
		});
		expect(objects.size).toBe(0);
		// The pending stays: the client can retry with the right file.
		expect(kv.size).toBe(1);
	});

	it("checks before encrypting, and creates no encryption key", async () => {
		const { createUpload, put, objects, keys } = setup({ isEncrypted: true });
		const url = await createUpload("image/png", "photo.png", "private");

		expect((await put(url, "image/png", withHead(HTML, HTML.length))).status).toBe(415);
		expect(objects.size).toBe(0);
		expect(keys.size).toBe(0);
	});

	it('stores a mismatch as application/octet-stream with contentSniffing: "octet-stream"', async () => {
		const { createUpload, put, objects } = setup({ contentSniffing: "octet-stream" });
		const url = await createUpload("image/png", "photo.png");

		expect((await put(url, "image/png", withHead(HTML, HTML.length))).status).toBe(200);
		expect(storedContentType([...objects.values()][0])).toBe("application/octet-stream");
	});

	it('skips the check with contentSniffing: "off"', async () => {
		const { createUpload, put, objects } = setup({ contentSniffing: "off" });
		const url = await createUpload("image/png", "photo.png");

		expect((await put(url, "image/png", withHead(HTML, HTML.length))).status).toBe(200);
		expect(storedContentType([...objects.values()][0])).toBe("image/png");
	});

	it("keeps a type outside the signature table as declared", async () => {
		const { createUpload, put, objects } = setup();
		const url = await createUpload("application/x-custom", "data.bin");

		expect((await put(url, "application/x-custom", withHead(HTML, HTML.length))).status).toBe(200);
		expect(storedContentType([...objects.values()][0])).toBe("application/x-custom");
	});

	it("never checks a transcode's outputs, and still checks an authenticated write of an original", async () => {
		const { put, objects } = setup({ isAuthenticated: true });
		const poster = "/v1/upload/public/video/vid1/thumbnails/poster.jpg";

		expect((await put(poster, "image/jpeg", new Uint8Array(32))).status).toBe(200);
		expect(storedContentType(objects.get("public/video/vid1/thumbnails/poster.jpg"))).toBe("image/jpeg");
		const original = await put("/v1/upload/public/image/i1/photo.png", "image/png", withHead(HTML, HTML.length));
		expect(original.status).toBe(415);
	});
});

describe("multipart content verification", () => {
	it("checks part 1 and lets the complete through once it passed", async () => {
		const { createUpload, createMultipart, putPart, complete, sessions } = setup();
		const url = await createUpload("video/mp4", "clip.mp4");
		const uploadId = await createMultipart(url, PART + 100);

		expect((await putPart(url, uploadId, 1, withHead(MP4_HEAD, PART))).status).toBe(200);
		expect((await putPart(url, uploadId, 2, new Uint8Array(100))).status).toBe(200);
		expect((await complete(url, uploadId, 2)).status).toBe(200);
		expect(sessions.get(uploadId)?.isAborted).toBe(false);
	});

	it("aborts the upload on a part-1 mismatch: R2 session, pending and encryption key", async () => {
		const { createUpload, createMultipart, putPart, sessions, kv, keys } = setup({ isEncrypted: true });
		const url = await createUpload("video/mp4", "clip.mp4", "private");
		const uploadId = await createMultipart(url, PART + 100);
		expect(keys.size).toBe(1);

		const res = await putPart(url, uploadId, 1, withHead(HTML, PART));

		expect(res.status).toBe(415);
		expect(await res.json()).toMatchObject({ code: "content_type_mismatch", declared: "video/mp4", detected: "html" });
		expect(sessions.get(uploadId)).toMatchObject({ isAborted: true, parts: [] });
		expect(kv.size).toBe(0);
		expect(keys.size).toBe(0);
		expect((await putPart(url, uploadId, 2, new Uint8Array(100))).status).toBe(404);
	});

	it("refuses the complete while part 1 is unverified, when parts arrive out of order", async () => {
		const { createUpload, createMultipart, putPart, complete } = setup();
		const url = await createUpload("video/mp4", "clip.mp4");
		const uploadId = await createMultipart(url, PART + 100);

		expect((await putPart(url, uploadId, 2, new Uint8Array(100))).status).toBe(200);
		const early = await complete(url, uploadId, 2);
		expect(early.status).toBe(409);
		expect(await early.json()).toMatchObject({ code: "content_unverified" });

		expect((await putPart(url, uploadId, 1, withHead(MP4_HEAD, PART))).status).toBe(200);
		expect((await complete(url, uploadId, 2)).status).toBe(200);
	});

	it('still rejects a mismatch with contentSniffing: "octet-stream" (the type is fixed at create)', async () => {
		const { createUpload, createMultipart, putPart, sessions } = setup({ contentSniffing: "octet-stream" });
		const url = await createUpload("video/mp4", "clip.mp4");
		const uploadId = await createMultipart(url, PART + 100);

		expect((await putPart(url, uploadId, 1, withHead(HTML, PART))).status).toBe(415);
		expect(sessions.get(uploadId)?.isAborted).toBe(true);
	});

	it('skips the check with contentSniffing: "off"', async () => {
		const { createUpload, createMultipart, putPart, complete } = setup({ contentSniffing: "off" });
		const url = await createUpload("video/mp4", "clip.mp4");
		const uploadId = await createMultipart(url, PART + 100);

		expect((await putPart(url, uploadId, 2, new Uint8Array(100))).status).toBe(200);
		expect((await putPart(url, uploadId, 1, withHead(HTML, PART))).status).toBe(200);
		expect((await complete(url, uploadId, 2)).status).toBe(200);
	});

	it("never checks a transcode's large outputs", async () => {
		const { createMultipart, putPart, complete, sessions } = setup({ isAuthenticated: true });
		const url = "/v1/upload/public/video/vid1/mp4/720p.mp4";
		const uploadId = await createMultipart(url, PART + 100, { contentType: "video/mp4" });

		expect(sessions.get(uploadId)?.contentType).toBe("video/mp4");
		expect((await putPart(url, uploadId, 2, new Uint8Array(100))).status).toBe(200);
		expect((await complete(url, uploadId, 2)).status).toBe(200);
		expect((await putPart(url, uploadId, 1, new Uint8Array(PART))).status).toBe(404);
	});
});
