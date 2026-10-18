import type { TranscodeSettings } from "@devultur/core";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_SECRETS, withWorkerAuth, workerWithMiddleware } from "../plugins/worker-secret-auth-test-env";
import { updateRequestState } from "../request-state";
import type { TranscodeContainerNamespace } from "../transcode/cloudflare";
import { readTranscodeOutputs } from "../transcode/outputs-report";

// Presets in the route: the config's default when the request doesn't name one, strict validation of an inline
// spec, and the preset's outputs in the client webhook with stable URLs.
const RAW_KEY = "public/video/vid1/raw/clip.mp4";
const ORIGIN = "https://acme.example.com";

function setup(presets?: TranscodeSettings, outputBaseUrl?: string) {
	const kv = new Map<string, string>();
	const scripts: string[] = [];
	const namespace: TranscodeContainerNamespace = {
		idFromName: (name) => name as unknown as DurableObjectId,
		get: () => ({
			launch: async (request) => {
				scripts.push(atob(request.env.TRANSCODE_SCRIPT_B64 ?? ""));
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
		MEDIA_BUCKET: { head: async () => ({ size: 10, customMetadata: {} }) },
		MEDIA_KV: {
			get: async (key: string, type?: string) => {
				const value = kv.get(key) ?? null;
				return type === "json" && value ? JSON.parse(value) : value;
			},
			put: async (key: string, value: string) => void kv.set(key, value),
			delete: async (key: string) => void kv.delete(key),
		},
	};
	const applyConfig: MiddlewareHandler = async (context, next) => {
		if (presets) updateRequestState(context, { config: { transcode: { presets: presets } } });
		if (outputBaseUrl) updateRequestState(context, { config: { transcode: { outputBaseUrl: outputBaseUrl } } });
		await next();
	};
	const app = workerWithMiddleware(applyConfig);
	const send = (path: string, init?: RequestInit) =>
		app.request(`${ORIGIN}${path}`, withWorkerAuth(init), env as never, { waitUntil() {} } as never);
	const transcode = (body: Record<string, unknown>) =>
		send("/v1/transcode", { method: "POST", body: JSON.stringify({ key: RAW_KEY, ...body }) });
	return { send, transcode, scripts };
}

afterEach(() => vi.restoreAllMocks());

describe("preset resolution in POST /v1/transcode", () => {
	const configPresets: TranscodeSettings = {
		presets: { landing: { mp4: { rungs: ["1080p"] }, audio: "strip" } },
		default: "landing",
	};

	it("with no preset in the request, applies the config's default", async () => {
		const { transcode, scripts } = setup(configPresets);
		const response = await transcode({});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ preset: "landing" });
		expect(scripts[0]).toContain("/tmp/mp4/main-1080p.mp4");
		expect(scripts[0]).toContain('\\"renditions\\":[$OUTPUTS_JSON]');
	});

	it("an explicit `hls-*` alias wins over the default and keeps the usual event", async () => {
		const { transcode, scripts } = setup(configPresets);
		const response = await transcode({ preset: "hls-adaptive" });
		expect(await response.json()).toMatchObject({ preset: "hls-adaptive" });
		expect(scripts[0]).not.toContain("/tmp/mp4/main-");
		expect(scripts[0]).not.toContain("renditions");
	});

	it("with no presets in the config → hls-720p", async () => {
		const { transcode } = setup();
		expect(await (await transcode({})).json()).toMatchObject({ preset: "hls-720p" });
	});

	it("an inline spec is validated strictly: 400 with the errors, without launching the job", async () => {
		const { transcode, scripts } = setup();
		const response = await transcode({ preset: { mp4: { rungs: ["1080p"] }, ffmpeg: "-vf evil" } });
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Invalid preset", details: ["spec.ffmpeg: unknown field"] });
		expect(scripts).toHaveLength(0);
	});

	it("an unknown name → 400", async () => {
		const { transcode } = setup(configPresets);
		expect((await transcode({ preset: "nope" })).status).toBe(400);
	});
});

describe("transcode.complete → client webhook", () => {
	const completion = {
		event: "transcode.complete",
		videoId: "vid1",
		duration: 12,
		playlistKey: "",
		thumbnailKey: "public/video/vid1/thumbnails/thumbnail.jpg",
		encode: { seconds: 8, cpus: 4 },
		renditions: [
			{
				variant: "main",
				kind: "mp4",
				rung: "1080p",
				key: "public/video/vid1/mp4/main-1080p.mp4",
				width: 1920,
				height: 1080,
			},
			{
				variant: "vertical",
				kind: "mp4",
				rung: "1080p",
				key: "public/video/vid1/mp4/vertical-1080p.mp4",
				width: 608,
				height: 1080,
			},
		],
		posterKey: "public/video/vid1/thumbnails/poster.jpg",
		posterFormats: ["jpg", "avif"],
		hasAudio: false,
	};

	it("maps keys → stable URLs on the job's host, with each output's size, without the encode measurement", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const forwarded: unknown[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			forwarded.push(JSON.parse(String(init?.body)));
			return new Response("ok");
		});
		const { transcode, send } = setup();
		await transcode({ preset: "hero", callbackUrl: "https://client.example/hook" });
		await send("/v1/webhooks/transcode", { method: "POST", body: JSON.stringify(completion) });

		expect(forwarded).toEqual([
			{
				event: "transcode.complete",
				videoId: "vid1",
				duration: 12,
				playlistKey: "",
				thumbnailKey: "public/video/vid1/thumbnails/thumbnail.jpg",
				renditions: [
					{
						variant: "main",
						kind: "mp4",
						rung: "1080p",
						key: "public/video/vid1/mp4/main-1080p.mp4",
						width: 1920,
						height: 1080,
						url: `${ORIGIN}/v1/media/public/video/vid1/mp4/main-1080p.mp4`,
					},
					{
						variant: "vertical",
						kind: "mp4",
						rung: "1080p",
						key: "public/video/vid1/mp4/vertical-1080p.mp4",
						width: 608,
						height: 1080,
						url: `${ORIGIN}/v1/media/public/video/vid1/mp4/vertical-1080p.mp4`,
					},
				],
				posterUrls: {
					jpg: `${ORIGIN}/v1/media/public/video/vid1/thumbnails/poster.jpg`,
					avif: `${ORIGIN}/v1/media/public/video/vid1/thumbnails/poster.jpg?format=avif`,
				},
				hasAudio: false,
			},
		]);
	});

	it("with a primary host in the config, URLs come from that host rather than the one that received the job", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const forwarded: Array<Record<string, unknown>> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			forwarded.push(JSON.parse(String(init?.body)));
			return new Response("ok");
		});
		const { transcode, send } = setup(undefined, "https://media.example.com");
		await transcode({ preset: "hero", callbackUrl: "https://client.example/hook" });
		await send("/v1/webhooks/transcode", { method: "POST", body: JSON.stringify(completion) });
		expect(forwarded[0]?.posterUrls).toEqual({
			jpg: "https://media.example.com/v1/media/public/video/vid1/thumbnails/poster.jpg",
			avif: "https://media.example.com/v1/media/public/video/vid1/thumbnails/poster.jpg?format=avif",
		});
	});

	it("discards renditions with keys outside a video or unknown kinds", () => {
		const outputs = readTranscodeOutputs(
			{
				...completion,
				renditions: [{ variant: "main", kind: "gif", rung: "1080p", key: "public/video/x/a.gif" }, { key: "../etc" }],
			},
			ORIGIN,
		);
		expect(outputs?.renditions).toEqual([]);
	});

	it("an event without renditions (an `hls-*` alias) is left untouched", () => {
		expect(readTranscodeOutputs({ event: "transcode.complete", videoId: "v" }, ORIGIN)).toBeNull();
	});
});
