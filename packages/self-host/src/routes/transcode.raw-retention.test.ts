import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_SECRETS, withWorkerAuth, workerWithMiddleware } from "../plugins/worker-secret-auth-test-env";
import { updateRequestState } from "../request-state";
import type { TranscodeContainerNamespace } from "../transcode/cloudflare";

// Original retention: with `DELETE_RAW_AFTER_TRANSCODE` the raw (and its L4 key) gets deleted once the transcode
// finishes SUCCESSFULLY; without it, it's retained; a failure never touches it. A re-transcode with no raw responds
// 410 explaining why.
const RAW_KEY = "private/video/vid1/raw/clip.mp4";
const PLAYLIST_KEY = "private/video/vid1/hls/playlist.m3u8";
const MP4_KEY = "private/video/vid1/mp4/main-720p.mp4";
const POSTER_KEY = "private/video/vid1/thumbnails/poster.jpg";
const RAW_L4_KEY = `${RAW_KEY}/key-1`;

function memoryBucket(keys: string[], lockedKeys: string[] = []) {
	const objects = new Set(keys);
	const lock = JSON.stringify({ hold: true });
	return {
		objects,
		head: async (key: string) =>
			objects.has(key) ? { size: 10, customMetadata: lockedKeys.includes(key) ? { lock } : {} } : null,
		delete: async (key: string | string[]) => {
			for (const each of Array.isArray(key) ? key : [key]) objects.delete(each);
		},
		list: async ({ prefix }: { prefix: string }) => ({
			objects: [...objects].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
			truncated: false,
		}),
	};
}

function setup(options: { deleteRaw?: boolean; objects?: string[]; lockedKeys?: string[] } = {}) {
	const kv = new Map<string, string>();
	const namespace: TranscodeContainerNamespace = {
		idFromName: (name) => name as unknown as DurableObjectId,
		get: () => ({ launch: async () => ({ alreadyRunning: false }), cancel: async () => {} }),
	};
	const mediaBucket = memoryBucket(options.objects ?? [RAW_KEY], options.lockedKeys);
	const keysBucket = memoryBucket([RAW_L4_KEY, "private/video/vid1/hls/key-2"]);
	const env = {
		...WORKER_SECRETS,
		TRANSCODE_RUNNER: "cloudflare",
		TRANSCODE_CONTAINER: namespace,
		DELIVERY_SIGN_SECRET: "delivery",
		MEDIA_BUCKET: mediaBucket,
		KEYS_BUCKET: keysBucket,
		MEDIA_KV: {
			get: async (key: string, type?: string) => {
				const value = kv.get(key) ?? null;
				return type === "json" && value ? JSON.parse(value) : value;
			},
			put: async (key: string, value: string) => void kv.set(key, value),
			delete: async (key: string) => void kv.delete(key),
		},
	};
	// The config decides this; here a middleware simulates it.
	const retention: MiddlewareHandler = async (context, next) => {
		if (options.deleteRaw !== undefined)
			updateRequestState(context, { config: { transcode: { deleteOriginalOnSuccess: options.deleteRaw } } });
		await next();
	};
	const app = workerWithMiddleware(retention);
	const send = (path: string, init?: RequestInit) =>
		app.request(`https://media.example${path}`, withWorkerAuth(init), env as never, { waitUntil() {} } as never);
	const transcode = () => send("/v1/transcode", { method: "POST", body: JSON.stringify({ key: RAW_KEY }) });
	const webhook = (event: Record<string, unknown>) =>
		send("/v1/webhooks/transcode", { method: "POST", body: JSON.stringify({ videoId: "vid1", ...event }) });
	return { send, transcode, webhook, mediaBucket, keysBucket };
}

afterEach(() => vi.restoreAllMocks());

describe("original retention after transcode", () => {
	it("deletes the raw and its L4 key after a successful transcode when retention is off", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { transcode, webhook, mediaBucket, keysBucket } = setup({ deleteRaw: true });
		expect((await transcode()).status).toBe(200);

		await webhook({ event: "transcode.complete", duration: 42 });

		expect(mediaBucket.objects.has(RAW_KEY)).toBe(false);
		expect([...keysBucket.objects]).toEqual(["private/video/vid1/hls/key-2"]);
	});

	it("keeps a locked raw even when asked to delete it, and the webhook still succeeds", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const { transcode, webhook, mediaBucket, keysBucket } = setup({ deleteRaw: true, lockedKeys: [RAW_KEY] });
		await transcode();

		const res = await webhook({ event: "transcode.complete", duration: 42 });

		expect(res.status).toBe(200);
		expect(mediaBucket.objects.has(RAW_KEY)).toBe(true);
		expect(keysBucket.objects.has(RAW_L4_KEY)).toBe(true);
		expect(log).toHaveBeenCalledWith(
			JSON.stringify({ event: "lock.original_retained", videoId: "vid1", key: RAW_KEY }),
		);
	});

	it("allows the first transcode of a locked raw (it only creates outputs)", async () => {
		const { transcode } = setup({ lockedKeys: [RAW_KEY] });
		expect((await transcode()).status).toBe(200);
	});

	it("refuses re-transcoding a locked video whose outputs already exist", async () => {
		const { transcode } = setup({ objects: [RAW_KEY, PLAYLIST_KEY], lockedKeys: [RAW_KEY] });
		const res = await transcode();
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "retention_active", key: RAW_KEY, hold: true });
	});

	it("keeps the raw when retention is on", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { transcode, webhook, mediaBucket, keysBucket } = setup({ deleteRaw: false });
		await transcode();

		await webhook({ event: "transcode.complete", duration: 42 });

		expect(mediaBucket.objects.has(RAW_KEY)).toBe(true);
		expect(keysBucket.objects.has(RAW_L4_KEY)).toBe(true);
	});

	it("keeps the raw by default (plain self-host)", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { transcode, webhook, mediaBucket } = setup();
		await transcode();

		await webhook({ event: "transcode.complete", duration: 42 });

		expect(mediaBucket.objects.has(RAW_KEY)).toBe(true);
	});

	it("never deletes the raw when the transcode fails", async () => {
		const { transcode, webhook, mediaBucket } = setup({ deleteRaw: true });
		await transcode();

		await webhook({ event: "transcode.failed", error: "boom", reason: "unsupported_codec", retriable: false });

		expect(mediaBucket.objects.has(RAW_KEY)).toBe(true);
	});

	it("explains a re-transcode whose original is no longer retained", async () => {
		const { transcode } = setup({ objects: [PLAYLIST_KEY] });

		const res = await transcode();

		expect(res.status).toBe(410);
		expect(await res.json()).toMatchObject({ code: "original_not_retained" });
	});

	it("explains it for an MP4-only video too (no HLS playlist to find)", async () => {
		const { transcode } = setup({ objects: [MP4_KEY, POSTER_KEY] });

		const res = await transcode();

		expect(res.status).toBe(410);
		expect(await res.json()).toMatchObject({ code: "original_not_retained" });
	});

	it("explains it when only the poster survives", async () => {
		const { transcode } = setup({ objects: [POSTER_KEY] });
		expect((await transcode()).status).toBe(410);
	});

	it("does not take another video's outputs for this one's", async () => {
		const { transcode } = setup({ objects: ["private/video/vid10/mp4/main-720p.mp4"] });
		expect((await transcode()).status).toBe(404);
	});

	it("removes the raw's L4 key with it when the sweeper deletes the raw directly", async () => {
		const { send, mediaBucket, keysBucket } = setup();

		const res = await send(`/v1/media/${RAW_KEY}`, { method: "DELETE" });

		expect(res.status).toBe(204);
		expect(mediaBucket.objects.has(RAW_KEY)).toBe(false);
		expect(keysBucket.objects.has(RAW_L4_KEY)).toBe(false);
	});

	it("still 404s a video that was never uploaded", async () => {
		const { transcode } = setup({ objects: [] });
		expect((await transcode()).status).toBe(404);
	});
});
