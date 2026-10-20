import {
	encodeEncryptionMeta,
	encryptBytes,
	exportEncryptionKey,
	generateEncryptionKey,
	generateIv,
} from "@devultur/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { signViewerToken } from "../helpers";
import { updateRequestState } from "../request-state";
import { readStoryboardKey, withClientStoryboard } from "../transcode/outputs-report";
import type { WorkerApp } from "../types";
import { isDerivedAssetKey } from "./derived-upload";
import { media } from "./media";
import { isStoryboardVttKey, rewriteStoryboardVtt } from "./storyboard-vtt";

const SECRET = "delivery-sign-secret";
const VTT = [
	"WEBVTT",
	"",
	"00:00:00.000 --> 00:00:02.000",
	"sprite-0.jpg#xywh=0,0,160,90",
	"",
	"00:00:02.000 --> 00:00:03.000",
	"sprite-1.jpg#xywh=160,0,160,90",
	"",
].join("\n");

const viewerToken = () => signViewerToken({ sub: "viewer", exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

interface StoredObject {
	bytes: Uint8Array;
	customMetadata?: Record<string, string>;
}

// In-memory MEDIA_BUCKET/KEYS_BUCKET: `get`, `head`, `list` by prefix, and batch `delete` (what delivery and DELETE
// use; the delete heads the raws for a lock).
function memoryBucket(objects: Map<string, StoredObject>) {
	return {
		get: async (key: string) => {
			const stored = objects.get(key);
			if (!stored) return null;
			return {
				httpMetadata: { contentType: "text/vtt" },
				customMetadata: stored.customMetadata,
				size: stored.bytes.length,
				httpEtag: '"e"',
				body: streamOf(stored.bytes),
				arrayBuffer: async () => stored.bytes.slice().buffer,
			};
		},
		head: async (key: string) => {
			const stored = objects.get(key);
			return stored ? { key, customMetadata: stored.customMetadata } : null;
		},
		list: async ({ prefix }: { prefix: string }) => ({
			objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
			truncated: false,
		}),
		delete: async (keys: string[]) => {
			for (const key of keys) objects.delete(key);
		},
	};
}

function workerWith(mediaObjects: Map<string, StoredObject>, keyObjects = new Map<string, StoredObject>()) {
	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		updateRequestState(context, { storagePrefix: "proj/" });
		await next();
	});
	app.route("/v1/media", media);
	const env = {
		MEDIA_BUCKET: memoryBucket(mediaObjects),
		KEYS_BUCKET: memoryBucket(keyObjects),
		DELIVERY_SIGN_SECRET: SECRET,
	} as unknown as WorkerApp["Bindings"];
	const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
	return { request: (path: string, init?: RequestInit) => app.request(`http://worker${path}`, init, env, ctx) };
}

const PRIVATE_VTT = "private/video/vid1/storyboard/storyboard.vtt";

describe("rewriteStoryboardVtt", () => {
	it("adds the token to each sprite, before the #xywh fragment", () => {
		expect(rewriteStoryboardVtt(VTT, "tok")).toBe(VTT.replace(/sprite-(\d)\.jpg#/g, "sprite-$1.jpg?token=tok#"));
	});

	it("does not touch timestamps, the header, or unrelated lines", () => {
		const other =
			"WEBVTT\n\nNOTE sprite-0.jpg is the sheet\n\n00:00:00.000 --> 00:00:01.000\nhttps://x/a.jpg#xywh=0,0,1,1\n";
		expect(rewriteStoryboardVtt(other, "tok")).toBe(other);
	});

	it("only storyboard/ VTTs (captions/ ones are not rewritten)", () => {
		expect(isStoryboardVttKey(PRIVATE_VTT)).toBe(true);
		expect(isStoryboardVttKey("private/video/vid1/captions/es.vtt")).toBe(false);
	});
});

describe("storyboard VTT delivery", () => {
	it("private: the VTT comes back with the viewer's token on each sprite, no shared cache", async () => {
		const objects = new Map([[`proj/${PRIVATE_VTT}`, { bytes: new TextEncoder().encode(VTT) }]]);
		const token = await viewerToken();
		const res = await workerWith(objects).request(`/v1/media/${PRIVATE_VTT}?token=${token}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-cache");
		expect(res.headers.get("Content-Type")).toContain("text/vtt");
		const body = await res.text();
		expect(body).toContain(`sprite-0.jpg?token=${token}#xywh=0,0,160,90`);
		expect(body).toContain(`sprite-1.jpg?token=${token}#xywh=160,0,160,90`);
	});

	it("private, encrypted at-rest (L4): decrypts and then rewrites", async () => {
		const cryptoKey = await generateEncryptionKey();
		const iv = generateIv();
		const plaintext = new TextEncoder().encode(VTT);
		const objects = new Map([
			[
				`proj/${PRIVATE_VTT}`,
				{
					bytes: await encryptBytes(plaintext, cryptoKey, iv),
					customMetadata: { enc: encodeEncryptionMeta(iv, "k1") },
				},
			],
		]);
		const keys = new Map([[`proj/${PRIVATE_VTT}/k1`, { bytes: new Uint8Array(await exportEncryptionKey(cryptoKey)) }]]);
		const token = await viewerToken();
		const res = await workerWith(objects, keys).request(`/v1/media/${PRIVATE_VTT}?token=${token}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(rewriteStoryboardVtt(VTT, token));
	});

	it("private without a token → 401 (the gate runs before the rewrite)", async () => {
		const objects = new Map([[`proj/${PRIVATE_VTT}`, { bytes: new TextEncoder().encode(VTT) }]]);
		const res = await workerWith(objects).request(`/v1/media/${PRIVATE_VTT}`);
		expect(res.status).toBe(401);
	});

	it("public without a token: the VTT as-is (relative sprites, cacheable)", async () => {
		const key = "public/video/vid1/storyboard/storyboard.vtt";
		const objects = new Map([[`proj/${key}`, { bytes: new TextEncoder().encode(VTT) }]]);
		const res = await workerWith(objects).request(`/v1/media/${key}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(VTT);
	});
});

describe("DELETE /v1/media/videos/:id", () => {
	it("deletes the video's folder (storyboard included) and, when private, its L4 keys", async () => {
		const bytes = { bytes: new Uint8Array(1) };
		const mediaObjects = new Map([
			["proj/private/video/vid1/raw/clip.mp4", bytes],
			["proj/private/video/vid1/storyboard/storyboard.vtt", bytes],
			["proj/private/video/vid1/storyboard/sprite-0.jpg", bytes],
			["proj/private/video/vid2/storyboard/sprite-0.jpg", bytes],
		]);
		const keyObjects = new Map([
			["proj/private/video/vid1/hls/hlskey", bytes],
			["proj/private/video/vid1/storyboard/sprite-0.jpg/k1", bytes],
			["proj/private/video/vid1/raw/clip.mp4/k0", bytes],
			["proj/private/video/vid2/storyboard/sprite-0.jpg/k9", bytes],
		]);
		const res = await workerWith(mediaObjects, keyObjects).request("/v1/media/videos/vid1?visibility=private", {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ videoId: "vid1", deletedCount: 3, deletedKeyCount: 3 });
		expect([...mediaObjects.keys()]).toEqual(["proj/private/video/vid2/storyboard/sprite-0.jpg"]);
		expect([...keyObjects.keys()]).toEqual(["proj/private/video/vid2/storyboard/sprite-0.jpg/k9"]);
	});

	it("public: does not sweep the keys bucket (public never encrypts)", async () => {
		const mediaObjects = new Map([["proj/public/video/vid1/storyboard/sprite-0.jpg", { bytes: new Uint8Array(1) }]]);
		const keyObjects = new Map([["proj/public/video/vid1/stray", { bytes: new Uint8Array(1) }]]);
		const res = await workerWith(mediaObjects, keyObjects).request("/v1/media/videos/vid1?visibility=public", {
			method: "DELETE",
		});
		expect(await res.json()).toEqual({ videoId: "vid1", deletedCount: 1, deletedKeyCount: 0 });
		expect(keyObjects.size).toBe(1);
	});
});

describe("storyboard allowlists", () => {
	it("the runner can upload to storyboard/ (one level, no subfolders)", () => {
		expect(isDerivedAssetKey("private/video/vid1/storyboard/sprite-0.jpg")).toBe(true);
		expect(isDerivedAssetKey("public/video/vid1/storyboard/storyboard.vtt")).toBe(true);
		expect(isDerivedAssetKey("public/video/vid1/storyboard/x/sprite-0.jpg")).toBe(false);
	});

	it("readStoryboardKey: only a video's storyboard/ VTT", () => {
		expect(readStoryboardKey({ storyboardKey: PRIVATE_VTT })).toBe(PRIVATE_VTT);
		expect(readStoryboardKey({ storyboardKey: "" })).toBeNull();
		expect(readStoryboardKey({ storyboardKey: "https://evil/storyboard.vtt" })).toBeNull();
		expect(readStoryboardKey({ storyboardKey: "private/video/vid1/hls/playlist.m3u8" })).toBeNull();
	});

	it("reaches the client with the preset's outputs; with an hls-* alias or empty, it's stripped", () => {
		const complete = { event: "transcode.complete", videoId: "vid1", storyboardKey: PRIVATE_VTT };
		expect(withClientStoryboard({ ...complete, renditions: [] })).toEqual({ ...complete, renditions: [] });
		expect(withClientStoryboard(complete)).toEqual({ event: "transcode.complete", videoId: "vid1" });
		expect(withClientStoryboard({ ...complete, storyboardKey: "", renditions: [] })).toEqual({
			event: "transcode.complete",
			videoId: "vid1",
			renditions: [],
		});
		expect(withClientStoryboard({ event: "transcode.progress" })).toEqual({ event: "transcode.progress" });
	});
});
