import { createMediaRouter, type MediaEvent } from "@devultur/core";
import { describe, expect, it, vi } from "vitest";
import { createWebhookHandler } from "./handlers";

// The media Worker posts its events as `Authorization: Bearer <secret>` + a JSON `MediaEvent`.
const SECRET = "worker-secret";
const router = createMediaRouter({ baseUrl: "https://media.example.com", secret: SECRET });

const COMPLETE: MediaEvent = {
	event: "transcode.complete",
	videoId: "vid1",
	duration: 12,
	playlistKey: "public/video/vid1/hls/playlist.m3u8",
	thumbnailKey: "public/video/vid1/thumbnails/thumbnail.jpg",
};

const request = (body: unknown, authorization?: string) => ({
	method: "POST",
	url: "https://app.example.com/webhooks/media",
	headers: authorization ? { authorization } : {},
	body,
});

describe("createWebhookHandler", () => {
	it("accepts the Worker's bearer and hands the typed event to its callback", async () => {
		const onTranscodeComplete = vi.fn(async () => {});
		const onEvent = vi.fn(async () => {});
		const handle = createWebhookHandler(router, { secret: SECRET, onEvent, onTranscodeComplete });

		const res = await handle(request(COMPLETE, `Bearer ${SECRET}`));

		expect(res.status).toBe(200);
		expect(onEvent).toHaveBeenCalledWith(COMPLETE);
		expect(onTranscodeComplete).toHaveBeenCalledWith(COMPLETE);
	});

	it("parses a raw JSON body and dispatches failures to their own callback", async () => {
		const onTranscodeFailed = vi.fn(async () => {});
		const onTranscodeComplete = vi.fn(async () => {});
		const handle = createWebhookHandler(router, { secret: SECRET, onTranscodeFailed, onTranscodeComplete });
		const failed = { event: "transcode.failed", videoId: "vid1", error: "boom", reason: "internal", retriable: true };

		const res = await handle(request(JSON.stringify(failed), `Bearer ${SECRET}`));

		expect(res.status).toBe(200);
		expect(onTranscodeFailed).toHaveBeenCalledWith(failed);
		expect(onTranscodeComplete).not.toHaveBeenCalled();
	});

	it("answers 401 to a wrong or missing bearer without calling anything", async () => {
		const onEvent = vi.fn(async () => {});
		const handle = createWebhookHandler(router, { secret: SECRET, onEvent });

		expect((await handle(request(COMPLETE, "Bearer nope"))).status).toBe(401);
		expect((await handle(request(COMPLETE))).status).toBe(401);
		expect(onEvent).not.toHaveBeenCalled();
	});

	it("fails closed with an empty secret", async () => {
		const handle = createWebhookHandler(router, { secret: "" });
		expect((await handle(request(COMPLETE, "Bearer "))).status).toBe(401);
	});
});
