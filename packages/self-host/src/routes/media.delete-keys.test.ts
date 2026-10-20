import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { updateRequestState } from "../request-state";
import type { WorkerApp } from "../types";
import { media } from "./media";
import { upload } from "./upload";

// In-memory R2 with the surface upload + delete use (put/head/list/delete by key or batch).
function memoryBucket() {
	const objects = new Map<string, unknown>();
	return {
		objects,
		put: async (key: string, body: unknown) => {
			objects.set(key, body);
		},
		head: async (key: string) => (objects.has(key) ? { key } : null),
		get: async () => null,
		list: async ({ prefix }: { prefix: string }) => ({
			objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
			truncated: false,
		}),
		delete: async (keys: string | string[]) => {
			for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
		},
	};
}

function keysUnder(bucket: ReturnType<typeof memoryBucket>, prefix: string): string[] {
	return [...bucket.objects.keys()].filter((key) => key.startsWith(prefix));
}

function workerSetup() {
	const mediaBucket = memoryBucket();
	const keysBucket = memoryBucket();

	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		updateRequestState(context, { storagePrefix: "prefix-a/", access: { authenticated: true } });
		updateRequestState(context, { config: { security: { encrypt: true } } });
		await next();
	});
	app.route("/v1/upload", upload);
	app.route("/v1/media", media);

	const env = {
		MEDIA_BUCKET: mediaBucket,
		KEYS_BUCKET: keysBucket,
		MEDIA_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
	} as unknown as WorkerApp["Bindings"];

	const putObject = (key: string, contentType: string) =>
		app.request(
			`http://worker/v1/upload/${key}`,
			{ method: "PUT", body: new Uint8Array(64), headers: { "Content-Type": contentType } },
			env,
		);

	return { app, env, mediaBucket, keysBucket, putObject };
}

describe("delete sweeps the L4 keys from KEYS_BUCKET", () => {
	it("DELETE /:key deletes the object AND its encryption key", async () => {
		const { app, env, mediaBucket, keysBucket, putObject } = workerSetup();
		const key = "private/image/abc/foto.jpg";
		await putObject(key, "image/jpeg");
		expect(keysUnder(keysBucket, `prefix-a/${key}/`)).toHaveLength(1);

		const res = await app.request(`http://worker/v1/media/${key}`, { method: "DELETE" }, env);

		expect(res.status).toBe(204);
		expect(mediaBucket.objects.has(`prefix-a/${key}`)).toBe(false);
		expect(keysUnder(keysBucket, `prefix-a/${key}/`)).toEqual([]);
	});

	it("DELETE /:key doesn't touch another object's keys with a similar prefix", async () => {
		const { app, env, keysBucket, putObject } = workerSetup();
		await putObject("private/image/abc/foto.jpg", "image/jpeg");
		await putObject("private/image/abc/foto.jpg2", "image/jpeg");

		await app.request("http://worker/v1/media/private/image/abc/foto.jpg", { method: "DELETE" }, env);

		expect(keysUnder(keysBucket, "prefix-a/private/image/abc/foto.jpg2/")).toHaveLength(1);
	});

	it("DELETE /videos/:id deletes the raw, thumbnail, and HLS keys of the video", async () => {
		const { app, env, mediaBucket, keysBucket, putObject } = workerSetup();
		await putObject("private/video/vid1/raw/clip.mp4", "video/mp4");
		await putObject("private/video/vid1/hls/thumbnail.jpg", "image/jpeg");
		// The HLS's AES-128 key is written by the transcode at `${storageKey(hls/{keyId})}` (see routes/transcode.ts).
		await keysBucket.put("prefix-a/private/video/vid1/hls/hlskey1", new Uint8Array(16));
		await putObject("private/video/vid2/raw/other.mp4", "video/mp4");
		expect(keysUnder(keysBucket, "prefix-a/private/video/vid1/")).toHaveLength(3);

		const res = await app.request("http://worker/v1/media/videos/vid1?visibility=private", { method: "DELETE" }, env);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ videoId: "vid1", deletedCount: 2, deletedKeyCount: 3 });
		expect(keysUnder(mediaBucket, "prefix-a/private/video/vid1/")).toEqual([]);
		expect(keysUnder(keysBucket, "prefix-a/private/video/vid1/")).toEqual([]);
		expect(keysUnder(keysBucket, "prefix-a/private/video/vid2/")).toHaveLength(1);
	});
});
