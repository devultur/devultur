import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { updateRequestState } from "../request-state";
import { sniffableBytes } from "../test-fixtures";
import type { RawStorageClass, WorkerApp } from "../types";
import { upload } from "./upload";

// A video raw's storage class: decided by the config (original retention) on the POST, and travels in the pending
// → the single PUT and the multipart create (both credential-less) apply it. Image/file always stay on Standard.

function setup(rawStorageClass?: RawStorageClass) {
	const kv = new Map<string, string>();
	const putOptions = new Map<string, R2PutOptions | undefined>();
	const multipartOptions = new Map<string, R2MultipartOptions | undefined>();
	const env = {
		MEDIA_KV: {
			get: async (key: string) => kv.get(key) ?? null,
			put: async (key: string, value: string) => void kv.set(key, value),
			delete: async (key: string) => void kv.delete(key),
		},
		MEDIA_BUCKET: {
			// Empty bucket: the lock check finds nothing to overwrite.
			head: async () => null,
			put: async (key: string, _value: unknown, options?: R2PutOptions) => {
				putOptions.set(key, options);
				return {};
			},
			createMultipartUpload: async (key: string, options?: R2MultipartOptions) => {
				multipartOptions.set(key, options);
				return { key, uploadId: "up-1" };
			},
		},
	};
	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		updateRequestState(context, { storagePrefix: "prefix-a/" });
		if (rawStorageClass) updateRequestState(context, { config: { originalStorageClass: rawStorageClass } });
		await next();
	});
	app.route("/v1/upload", upload);
	const send = (path: string, init: RequestInit) => app.request(path, init, env as never);

	// The upload URL the POST returned, by key (carries the pending's id).
	const uploadUrls = new Map<string, string>();
	async function create(contentType: string, filename: string) {
		const res = await send("/v1/upload", { method: "POST", body: JSON.stringify({ filename, contentType }) });
		const created = (await res.json()) as { key: string; uploadUrl: string };
		uploadUrls.set(created.key, created.uploadUrl);
		return created.key;
	}
	async function putBytes(key: string, contentType: string) {
		await send(`${uploadUrls.get(key)}`, {
			method: "PUT",
			headers: { "Content-Type": contentType },
			body: sniffableBytes(contentType),
		});
		return putOptions.get(`prefix-a/${key}`)?.storageClass;
	}
	async function createMultipart(key: string) {
		await send(`${uploadUrls.get(key)}&multipart=create`, { method: "POST", body: JSON.stringify({ size: 10 }) });
		return multipartOptions.get(`prefix-a/${key}`)?.storageClass;
	}
	return { create, putBytes, createMultipart };
}

describe("raw video storage class", () => {
	it("stores a video raw in Infrequent Access when the config asks to keep originals ≥30 days", async () => {
		const { create, putBytes } = setup("InfrequentAccess");
		const key = await create("video/mp4", "clip.mp4");
		expect(await putBytes(key, "video/mp4")).toBe("InfrequentAccess");
	});

	it("applies the same class to a multipart upload", async () => {
		const { create, createMultipart } = setup("InfrequentAccess");
		const key = await create("video/mp4", "clip.mp4");
		expect(await createMultipart(key)).toBe("InfrequentAccess");
	});

	it("keeps Standard when the config asks for it (retention off)", async () => {
		const { create, putBytes } = setup("Standard");
		const key = await create("video/mp4", "clip.mp4");
		expect(await putBytes(key, "video/mp4")).toBe("Standard");
	});

	it("defaults to Standard when the config sets no storage class", async () => {
		const { create, putBytes, createMultipart } = setup();
		const key = await create("video/mp4", "clip.mp4");
		expect(await createMultipart(key)).toBe("Standard");
		expect(await putBytes(key, "video/mp4")).toBe("Standard");
	});

	it("never moves images or files out of Standard", async () => {
		const { create, putBytes } = setup("InfrequentAccess");
		const key = await create("image/png", "a.png");
		expect(await putBytes(key, "image/png")).toBe("Standard");
	});
});
