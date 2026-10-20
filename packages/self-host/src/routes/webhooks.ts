import { type Context, Hono } from "hono";
import { isTranscodeWebhookAuthorized, KV_JOB_TTL_SECONDS, KvPrefix } from "../helpers";
import { markTranscodeCompleted } from "../object-lock/transcode-marker";
import type { RequestState } from "../request-state";
import { addRouteResult } from "../route-result";
import { JOB_TICKET_HEADER, verifyJobLocation, verifyJobTicket } from "../transcode/job-ticket";
import { logEncodeMetrics, parseEncodeMetrics, withoutOperatorFields } from "../transcode/metrics";
import { loadOutputBaseUrl, withClientStoryboard, withOutputUrls } from "../transcode/outputs-report";
import { disposeRawAfterTranscode } from "../transcode/raw-retention";
import { applyStatusEvent } from "../transcode/status";
import type { WorkerApp } from "../types";

const webhooks = new Hono<WorkerApp>();

webhooks.post("/transcode", async (context) => {
	// The transcode script sends the shared secret that the Worker injected into its env (see transcode.ts).
	// Without it anyone with a videoId could POST a fake `transcode.complete`. Fail-closed: with no secret
	// configured the webhook accepts nothing.
	const webhookSecret = context.env.TRANSCODE_WEBHOOK_SECRET;
	if (!webhookSecret) {
		return context.json(
			{ error: "TRANSCODE_WEBHOOK_SECRET is not configured on the Worker", code: "webhook_secret_missing" },
			503,
		);
	}
	if (!isTranscodeWebhookAuthorized(webhookSecret, context.req.header("Authorization"))) {
		return context.json({ error: "Unauthorized" }, 401);
	}

	const body = await context.req.json();

	await publishTranscodeJob(context, body);

	if (body.event === "transcode.complete" && body.videoId) {
		// The raw is retained unless the config asked to delete it on completion (`deleteOriginalOnSuccess`): only
		// after a successful transcode; a `transcode.failed` never touches it.
		const disposal = await disposeRawAfterTranscode(context, body.videoId);
		if (disposal === "deleted") addRouteResult(context, { originalDeleted: true });
		if (disposal === "retained") addRouteResult(context, { originalRetained: true });
		const ticket = context.req.header(JOB_TICKET_HEADER);
		const location = await verifyJobLocation(context.env.DELIVERY_SIGN_SECRET, ticket, body.videoId);
		await markTranscodeCompleted(context.env, body.videoId, location);
		await context.env.MEDIA_KV.put(
			`${KvPrefix.TRANSCODE_META}:${body.videoId}`,
			JSON.stringify({ duration: body.duration }),
			{ expirationTtl: KV_JOB_TTL_SECONDS },
		);
		const metrics = parseEncodeMetrics(body);
		if (metrics) logEncodeMetrics(body.videoId, metrics);
	}

	// Job status (queued → running → completed | failed) for `GET /v1/transcode/:jobId`.
	await applyStatusEvent(context.env.MEDIA_KV, body);

	const webhookData = await getWebhookData(context.env.MEDIA_KV, body.videoId);

	// The encode measurement is the operator's (we log it above; a plugin reads it from the runner's body): the app
	// doesn't receive it, so its handler can validate strictly (reject unknown fields). The outputs of a preset (keys)
	// travel as stable URLs from the host that received the job.
	const outputBaseUrl = await loadOutputBaseUrl(context.env.MEDIA_KV, body.videoId, new URL(context.req.url).origin);
	const clientEvent = withClientStoryboard(withoutOperatorFields(withOutputUrls(body, outputBaseUrl)));

	await forwardToClientWebhook(clientEvent, webhookData);

	return context.json({ received: true });
});

/**
 * The job of a completion callback, from its signed ticket, for the middlewares that run after the route. A runner
 * launched before the ticket existed sends none; a ticket that does not verify (forged, expired, another video) is
 * left out and logged.
 */
async function publishTranscodeJob(context: Context<WorkerApp>, body: Record<string, unknown>): Promise<void> {
	const ticket = context.req.header(JOB_TICKET_HEADER);
	if (!ticket || body.event !== "transcode.complete" || typeof body.videoId !== "string") return;
	const job = await verifyJobTicket(context.env.DELIVERY_SIGN_SECRET, ticket, body.videoId);
	if (job) {
		addRouteResult(context, { transcodeJob: job });
		return;
	}
	console.warn(`[transcode] callback for ${body.videoId} carries a job ticket that does not verify`);
}

/** Client webhook of a video: its URL and the bearer sent with it (`""` = no `Authorization`). */
export interface WebhookData {
	url: string;
	credential: string;
}

/** KV key of the client webhook stored for a video (the runner's callbacks carry nothing else to find it). */
export function clientWebhookKvKey(videoId: string): string {
	return `${KvPrefix.CAPTION_JOB}:webhook:${videoId}`;
}

/** Client webhook of the request: its `callbackUrl` with the scope's callback credential. */
export function clientWebhookFor(scope: RequestState, url: string): WebhookData {
	return { url, credential: scope.webhookCredential ?? scope.runnerCredential ?? "" };
}

async function getWebhookData(kv: KVNamespace, videoId: string): Promise<WebhookData | null> {
	const raw = await kv.get(clientWebhookKvKey(videoId));
	if (!raw) return null;

	try {
		const stored = JSON.parse(raw) as Partial<WebhookData>;
		if (typeof stored.url !== "string") return null;
		return { url: stored.url, credential: typeof stored.credential === "string" ? stored.credential : "" };
	} catch {
		return { url: raw, credential: "" };
	}
}

async function forwardToClientWebhook(event: unknown, webhookData: WebhookData | null): Promise<void> {
	if (!webhookData?.url) return;

	try {
		const response = await fetch(webhookData.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(webhookData.credential ? { Authorization: `Bearer ${webhookData.credential}` } : {}),
			},
			body: JSON.stringify(event),
		});

		if (!response.ok) {
			const responseBody = await response.text();
			console.error("[webhook] forward failed:", response.status, webhookData.url, responseBody);
		}
	} catch (err) {
		console.error("[webhook] forward error:", webhookData.url, err);
	}
}

export { forwardToClientWebhook, getWebhookData, webhooks };
