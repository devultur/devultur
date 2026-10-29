// 1.5.x call sites of the webhook API compile, and type their results, exactly as before. Checked by `tsc` (the
// package's typecheck) through `expectTypeOf`, and run as plain tests.
import { describe, expect, expectTypeOf, it } from "vitest";
import { createWebhookEvent, type WebhookEvent } from "./lifecycle-events";
import { createMediaRouter } from "./router";
import type { MediaEvent, WebhookVerifyOptions } from "./types";
import { createHTTPWebhookHandler } from "./webhook";
import { signWebhook } from "./webhook-signature";

const router = createMediaRouter({ baseUrl: "https://media.example", secret: "worker-secret" });
const transcodeStarted = JSON.stringify({ event: "transcode.started", videoId: "v1", totalSegments: 1, duration: 2 });

describe("1.5.x webhook call sites", () => {
	it("router.handleWebhook with options typed WebhookVerifyOptions returns a MediaEvent", async () => {
		const options: WebhookVerifyOptions = { authorization: "Bearer worker-secret", secret: "worker-secret" };
		const event = await router.handleWebhook(transcodeStarted, options);

		expectTypeOf(event).toEqualTypeOf<MediaEvent>();
		expectTypeOf(event.event).toEqualTypeOf<MediaEvent["event"]>();
		expectTypeOf(event.videoId).toEqualTypeOf<string>();
		expectTypeOf(options.secret).toEqualTypeOf<string>();
	});

	it("createHTTPWebhookHandler keeps its options and its { event } result", async () => {
		const { handler } = createHTTPWebhookHandler({ secret: "worker-secret" });
		const request = new Request("https://app.example/webhook", {
			method: "POST",
			headers: { Authorization: "Bearer worker-secret" },
			body: transcodeStarted,
		});

		const result = await handler(null, request);

		expectTypeOf(result).toEqualTypeOf<Response | { event: MediaEvent }>();
		if (!(result instanceof Response)) expectTypeOf(result.event.videoId).toEqualTypeOf<string>();
	});
});

describe("router.verifyWebhook", () => {
	it("returns a signed webhook's envelope, and still takes a bearer one", async () => {
		const signingSecret = "whsec_cm91dGVyLXNpZ25pbmctc2VjcmV0";
		const event = createWebhookEvent("media.changed", {
			key: "public/file/f/a.pdf",
			mediaId: "f",
			changes: ["replaced"],
			etag: "e",
		});
		const body = JSON.stringify(event);
		const headers = await signWebhook({ id: event.id, payload: body, secret: signingSecret });

		const signed = await router.verifyWebhook(body, { signingSecret, headers });
		const bearer = await router.verifyWebhook(transcodeStarted, {
			secret: "worker-secret",
			headers: { Authorization: "Bearer worker-secret" },
		});

		expectTypeOf(signed).toEqualTypeOf<MediaEvent | WebhookEvent>();
		expect(signed).toEqual(event);
		expect(bearer).toMatchObject({ event: "transcode.started" });
	});
});
