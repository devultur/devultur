import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateRequestState } from "../request-state";
import type { WorkerApp } from "../types";
import { captions } from "./captions";

// What Groq responds on a real 429: org id and quotas. Must never reach the client.
const GROQ_429_BODY =
	'{"error":{"message":"Rate limit reached for model whisper-large-v3-turbo in organization org_01secret on seconds of audio per hour (ASPH): Limit 7200, Used 7190"}}';
const RAW_KEY = "public/video/vid1/raw/clip.mp4";
const CLIENT_HOOK = "https://client.example/hook";

function captionsApp() {
	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		updateRequestState(context, { storagePrefix: "" });
		updateRequestState(context, { runnerCredential: "" });
		await next();
	});
	app.route("/v1/captions", captions);
	return app;
}

const env = {
	MEDIA_BUCKET: {
		get: async () => ({ body: new Response("audio").body, customMetadata: {} }),
		put: async () => {},
		head: async () => null,
	},
	GROQ_API_KEY: "g",
	MISTRAL_API_KEY: "m",
	MEDIA_KV: { put: async () => {}, get: async () => null },
} as unknown as WorkerApp["Bindings"];

function stubProviders(groq: () => Response) {
	const webhookBodies: string[] = [];
	vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
		if (String(url).includes("groq")) return groq();
		if (String(url) === CLIENT_HOOK) webhookBodies.push(String(init?.body));
		return new Response("ok");
	});
	return webhookBodies;
}

async function requestCaptions() {
	return captionsApp().request(
		"http://worker/v1/captions",
		{
			method: "POST",
			body: JSON.stringify({ key: RAW_KEY, locales: ["es-CO"], callbackUrl: CLIENT_HOOK }),
			headers: { "Content-Type": "application/json" },
		},
		env,
	);
}

describe("captions: provider errors stay server-side", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("maps a Groq 429 to a rate-limited code without its body, in the response and the webhook", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const webhookBodies = stubProviders(() => new Response(GROQ_429_BODY, { status: 429 }));

		const res = await requestCaptions();

		expect(res.status).toBe(503);
		const text = await res.text();
		expect(text).not.toContain("org_01secret");
		expect(JSON.parse(text)).toEqual({
			error: "Captions provider is rate limited, try again later",
			code: "captions_provider_rate_limited",
		});
		expect(webhookBodies).toHaveLength(1);
		expect(webhookBodies[0]).not.toContain("org_01secret");
		expect(JSON.parse(webhookBodies[0] ?? "")).toEqual({
			event: "captions.failed",
			videoId: "vid1",
			error: "Captions provider is rate limited, try again later",
			reason: "capacity",
			retriable: true,
		});
		// The detail does stay in the server log for debugging.
		expect(errorSpy.mock.calls.flat().join(" ")).toContain("org_01secret");
	});

	it("maps any other provider failure to captions_provider_error", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const webhookBodies = stubProviders(() => new Response("upstream exploded: key gsk_abc", { status: 500 }));

		const res = await requestCaptions();

		expect(res.status).toBe(500);
		const text = await res.text();
		expect(text).not.toContain("gsk_abc");
		expect(JSON.parse(text)).toMatchObject({ code: "captions_provider_error" });
		expect(webhookBodies[0]).not.toContain("gsk_abc");
	});
});
