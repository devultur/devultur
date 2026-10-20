import { afterEach, describe, expect, it, vi } from "vitest";
import { isServiceToken, verifyViewerToken } from "../helpers";
import { createWorker } from "../index";
import { WORKER_SECRETS, withWorkerAuth } from "../plugins/worker-secret-auth-test-env";
import type { TranscodeContainerNamespace } from "../transcode/cloudflare";

// POST /v1/transcode launches on the chosen runner, and GET /:jobId responds with the state the script's
// webhooks write (not the state of the provider's machine).
const RAW_KEY = "public/video/vid1/raw/clip.mp4";

function setup(options: { launchError?: Error } = {}) {
	const kv = new Map<string, string>();
	const launches: Array<{ env: Record<string, string>; instance: string }> = [];
	const namespace: TranscodeContainerNamespace = {
		idFromName: (name) => name as unknown as DurableObjectId,
		get: () => ({
			launch: async (request) => {
				if (options.launchError) throw options.launchError;
				launches.push(request);
				return { alreadyRunning: false };
			},
			cancel: async () => {},
		}),
	};
	const env = {
		...WORKER_SECRETS,
		TRANSCODE_RUNNER: "cloudflare",
		TRANSCODE_CONTAINER: namespace,
		DELIVERY_SIGN_SECRET: "delivery",
		MEDIA_BUCKET: {
			head: async () => ({ size: 10, customMetadata: {} }),
			get: async () => null,
			put: async () => ({}),
		},
		MEDIA_KV: {
			get: async (key: string, type?: string) => {
				const value = kv.get(key) ?? null;
				return type === "json" && value ? JSON.parse(value) : value;
			},
			put: async (key: string, value: string) => void kv.set(key, value),
			delete: async (key: string) => void kv.delete(key),
		},
	};
	const app = createWorker();
	const send = (path: string, init?: RequestInit) =>
		app.request(`https://media.example${path}`, withWorkerAuth(init), env as never, { waitUntil() {} } as never);
	const webhook = (event: Record<string, unknown>) =>
		send("/v1/webhooks/transcode", { method: "POST", body: JSON.stringify({ videoId: "vid1", ...event }) });
	return { send, webhook, launches, kv };
}

afterEach(() => vi.restoreAllMocks());

describe("transcode through a runner", () => {
	it("launches on the configured runner and tags the job with its name and vCPU", async () => {
		const { send, launches } = setup();
		const res = await send("/v1/transcode", { method: "POST", body: JSON.stringify({ key: RAW_KEY }) });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ jobId: "cf-vid1", videoId: "vid1", status: "queued" });
		expect(launches[0]?.env).toMatchObject({
			VIDEO_ID: "vid1",
			INPUT_KEY: RAW_KEY,
			CALLBACK_URL: "https://media.example/v1/webhooks/transcode",
			TRANSCODE_RUNNER: "cloudflare",
			TRANSCODE_CPUS: "4",
		});
		expect(launches[0]?.env.TRANSCODE_SCRIPT_B64).toBeTruthy();
	});

	it("hands the machine a signed service token typed as `transcode`", async () => {
		const { send, launches } = setup();
		await send("/v1/transcode", { method: "POST", body: JSON.stringify({ key: RAW_KEY }) });
		const payload = await verifyViewerToken(launches[0]?.env.DOWNLOAD_TOKEN, "delivery");
		expect(payload).toMatchObject({ sub: "transcode:vid1", typ: "transcode" });
		expect(isServiceToken(payload)).toBe(true);
	});

	it("reports an unknown TRANSCODE_RUNNER instead of guessing", async () => {
		const res = await createWorker().request(
			"https://media.example/v1/transcode",
			withWorkerAuth({ method: "POST", body: JSON.stringify({ key: RAW_KEY }) }),
			{
				...WORKER_SECRETS,
				TRANSCODE_RUNNER: "lambda",
				DELIVERY_SIGN_SECRET: "d",
				MEDIA_BUCKET: {
					head: async () => ({ size: 1, customMetadata: {} }),
					get: async () => null,
					put: async () => ({}),
				},
				MEDIA_KV: { get: async () => null, put: async () => {} },
			} as never,
		);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "Invalid TRANSCODE_RUNNER", code: "transcode_not_configured" });
	});

	it("returns a stable code and keeps the provider's error out of the response", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const vendorBody = "upstream capacity error: no machines available in region";
		const { send } = setup({ launchError: new Error(vendorBody) });
		const res = await send("/v1/transcode", { method: "POST", body: JSON.stringify({ key: RAW_KEY }) });

		expect(res.status).toBe(503);
		const text = await res.text();
		expect(text).not.toContain(vendorBody);
		expect(JSON.parse(text)).toEqual({
			error: "Failed to start transcode container",
			code: "transcode_runner_unavailable",
		});
		expect(errorSpy.mock.calls.flat().join(" ")).toContain(vendorBody);
	});

	it("walks queued → running → failed from the script webhooks", async () => {
		const { send, webhook } = setup();
		await send("/v1/transcode", { method: "POST", body: JSON.stringify({ key: RAW_KEY }) });
		const status = async () => (await send("/v1/transcode/cf-vid1")).json();

		expect(await status()).toEqual({ jobId: "cf-vid1", status: "queued" });
		await webhook({ event: "transcode.progress", phase: "downloading", currentSegment: 0, totalSegments: 100 });
		expect(await status()).toEqual({ jobId: "cf-vid1", status: "running" });
		await webhook({ event: "transcode.failed", error: "boom", reason: "unsupported_codec", retriable: false });
		expect(await status()).toEqual({
			jobId: "cf-vid1",
			status: "failed",
			error: "boom",
			reason: "unsupported_codec",
			retriable: false,
		});
	});

	it("reports completed with duration and output keys, and a late failure does not override it", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { send, webhook } = setup();
		await send("/v1/transcode", { method: "POST", body: JSON.stringify({ key: RAW_KEY }) });
		await webhook({ event: "transcode.complete", duration: 42, encodeSeconds: 10, cpus: 4 });
		await webhook({ event: "transcode.failed", error: "container stopped" });

		expect(await (await send("/v1/transcode/cf-vid1")).json()).toEqual({
			jobId: "cf-vid1",
			status: "completed",
			duration: 42,
			playlistUrl: "public/video/vid1/hls/playlist.m3u8",
			thumbnailKey: "public/video/vid1/thumbnails/thumbnail.jpg",
		});
	});

	it("404s an unknown job", async () => {
		const { send } = setup();
		expect((await send("/v1/transcode/nope")).status).toBe(404);
	});
});
