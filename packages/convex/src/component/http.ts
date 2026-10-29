import { authenticateWebhook, isMediaLifecycleEvent, isWebhookEvent, WebhookAuthError } from "@devultur/core";
import { httpRouter } from "convex/server";
import { api, internal } from "./_generated/api";
import { env, httpAction } from "./_generated/server";
import { lifecycleEventArgs } from "./lifecycleValidators";

const http = httpRouter();

const signingSecrets = (value: string | undefined) => (value ?? "").split(/\s+/).filter(Boolean);

http.route({
	path: "/webhook",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		// A signed request (the Worker's media webhooks) is verified with `DEVULTUR_WEBHOOK_SECRET`; any other one needs
		// `Bearer <DEVULTUR_SECRET>` (a job's `callbackUrl`). Fails closed: with the secret unset or empty, nothing passes.
		const body = await request.text();
		let payload: unknown;
		try {
			const signingSecret = signingSecrets(env.DEVULTUR_WEBHOOK_SECRET);
			payload = await authenticateWebhook(body, {
				headers: request.headers,
				secret: env.DEVULTUR_SECRET,
				...(signingSecret.length > 0 ? { signingSecret } : {}),
			});
		} catch (error) {
			if (error instanceof WebhookAuthError) return new Response("Unauthorized", { status: 401 });
			return new Response("Bad Request", { status: 400 });
		}

		try {
			if (isMediaLifecycleEvent(payload)) {
				await ctx.runMutation(api.lifecycle.applyLifecycleEvent, { event: lifecycleEventArgs(payload) });
			} else {
				// A transcode or captions event, bare (a job's `callbackUrl`) or in the envelope (a media webhook).
				const event = isWebhookEvent(payload) ? payload.data : payload;
				await ctx.runMutation(internal.public.handleWebhookEvent, event as never);
			}
			return new Response("OK", { status: 200 });
		} catch {
			return new Response("Bad Request", { status: 400 });
		}
	}),
});

export default http;
