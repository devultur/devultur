import { MULTIPART_PART_SIZE_BYTES, type SecurityPolicy } from "@devultur/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { updateRequestState } from "../request-state";
import type { WorkerApp } from "../types";
import { isDerivedAssetKey } from "./derived-upload";
import { upload } from "./upload";

// Multipart for a transcode output (a large MP4): with no prior pending, the credentialed create builds one for
// the derived asset's fixed key; the rest of the protocol and L4 encryption are the same as a client's large upload.
const MP4_KEY = "private/video/vid1/mp4/main-1080p.mp4";
const PART = MULTIPART_PART_SIZE_BYTES;

function setup(security?: SecurityPolicy) {
	const kv = new Map<string, string>();
	const parts = new Map<number, Uint8Array>();
	const created: Array<{ key: string; options: R2MultipartOptions | undefined }> = [];
	const objects = new Map<string, Uint8Array>();
	const resume = (key: string) => ({
		uploadPart: async (partNumber: number, value: ArrayBuffer | Uint8Array) => {
			parts.set(partNumber, new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value)));
			return { partNumber, etag: `etag-${partNumber}` };
		},
		complete: async (completed: Array<{ partNumber: number }>) => {
			const chunks = completed.map((part) => parts.get(part.partNumber) ?? new Uint8Array());
			const bytes = new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer());
			objects.set(key, bytes);
			return { size: bytes.length };
		},
		abort: async () => {},
	});
	const env = {
		MEDIA_KV: {
			get: async (key: string) => kv.get(key) ?? null,
			put: async (key: string, value: string) => void kv.set(key, value),
			delete: async (key: string) => void kv.delete(key),
		},
		MEDIA_BUCKET: {
			// Empty bucket: the lock check finds nothing to overwrite.
			head: async () => null,
			list: async () => ({ objects: [], truncated: false }),
			createMultipartUpload: async (key: string, options?: R2MultipartOptions) => {
				created.push({ key, options });
				return { uploadId: "up-1", key, ...resume(key) };
			},
			resumeMultipartUpload: resume,
		},
		KEYS_BUCKET: { put: async () => {}, get: async () => null },
	} as unknown as WorkerApp["Bindings"];

	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		// The auth layer sets the prefix; the test picks it via a header.
		updateRequestState(context, {
			storagePrefix: context.req.header("x-test-prefix") ?? "prefix-a/",
			...(context.req.header("Authorization") ? { access: { authenticated: true } } : {}),
		});
		if (security) updateRequestState(context, { config: { security: security } });
		await next();
	});
	app.route("/v1/upload", upload);
	const create = (key: string, headers: Record<string, string> = { Authorization: "Bearer svc" }) =>
		app.request(
			`http://worker/v1/upload/${key}?multipart=create`,
			{ method: "POST", headers, body: JSON.stringify({ size: PART + 5, contentType: "video/mp4" }) },
			env,
		);
	const send = (query: string, init: RequestInit, headers: Record<string, string> = { Authorization: "Bearer svc" }) =>
		app.request(`http://worker/v1/upload/${MP4_KEY}${query}`, { ...init, headers }, env);
	return { create, send, created, kv, objects, app, env };
}

describe("derived asset multipart", () => {
	it("recognizes only keys of a video's derived assets", () => {
		expect(isDerivedAssetKey(MP4_KEY)).toBe(true);
		expect(isDerivedAssetKey("public/video/vid1/thumbnails/poster.jpg")).toBe(true);
		expect(isDerivedAssetKey("private/video/vid1/raw/clip.mp4")).toBe(false);
		expect(isDerivedAssetKey("private/video/vid1/mp4/nested/a.mp4")).toBe(false);
		expect(isDerivedAssetKey("private/image/img1/a.jpg")).toBe(false);
	});

	it("with a credential, create builds the fixed key's pending and opens the multipart under the storage prefix", async () => {
		const { create, created, kv } = setup();
		const response = await create(MP4_KEY);
		expect(await response.json()).toEqual({ uploadId: "up-1", partSize: PART, partCount: 2 });
		expect(created[0]?.key).toBe(`prefix-a/${MP4_KEY}`);
		expect(created[0]?.options?.httpMetadata).toMatchObject({ contentType: "video/mp4" });
		// The session lives under the full storage key (with the storage prefix), not under the virtual key.
		expect(JSON.parse(kv.get(`upload-pending:prefix-a/${MP4_KEY}`) ?? "{}")).toMatchObject({
			storageKey: `prefix-a/${MP4_KEY}`,
			multipart: { uploadId: "up-1", size: PART + 5 },
		});
	});

	it("without a credential, or for a key that isn't derived, still requires the pending (404)", async () => {
		const { create, created } = setup();
		expect((await create(MP4_KEY, {})).status).toBe(404);
		expect((await create("private/video/vid1/raw/clip.mp4")).status).toBe(404);
		expect(created).toHaveLength(0);
	});

	it("with a credential, the parts and complete follow the session without a pending id", async () => {
		const { create, send, objects } = setup();
		await create(MP4_KEY);
		const first = await send("?uploadId=up-1&partNumber=1", { method: "PUT", body: new Uint8Array(PART) });
		const second = await send("?uploadId=up-1&partNumber=2", { method: "PUT", body: new Uint8Array(5) });
		expect([first.status, second.status]).toEqual([200, 200]);
		const done = await send("?multipart=complete", {
			method: "POST",
			body: JSON.stringify({
				uploadId: "up-1",
				parts: [
					{ partNumber: 1, etag: "etag-1" },
					{ partNumber: 2, etag: "etag-2" },
				],
			}),
		});
		expect(done.status).toBe(200);
		expect(objects.get(`prefix-a/${MP4_KEY}`)?.length).toBe(PART + 5);
	});

	it("a storage prefix's session is unreachable from another prefix or a request without a credential (404)", async () => {
		const { create, send } = setup();
		await create(MP4_KEY);
		const otherCaller = await send(
			"?uploadId=up-1&partNumber=2",
			{ method: "PUT", body: new Uint8Array(5) },
			{ Authorization: "Bearer svc", "x-test-prefix": "prefix-b/" },
		);
		const anonymous = await send("?uploadId=up-1&partNumber=2", { method: "PUT", body: new Uint8Array(5) }, {});
		expect([otherCaller.status, anonymous.status]).toEqual([404, 404]);
	});

	it("a private MP4 with encrypt on ends up encrypted (L4) just like a client's large upload", async () => {
		const { create, created } = setup({ encrypt: true });
		await create(MP4_KEY);
		expect(created[0]?.options?.customMetadata?.enc).toBeTruthy();
	});
});
