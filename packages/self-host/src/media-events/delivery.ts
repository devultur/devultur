// Delivering a media event: one signed POST per attempt, and a record of how it went in KV
// (`webhook-delivery:{eventId}`, 7 days). With a `WEBHOOK_QUEUE` the attempts are retried with backoff by the
// `deliverWebhooks` consumer; without one there's a single attempt after the response.
//
// The message carries the target's secrets: a retry hours later is signed again (receivers refuse a stale timestamp),
// and the scope that set the target isn't known to the consumer.
import { signWebhook, type WebhookEvent } from "@devultur/core";
import type { WorkerEnv } from "../types";

export interface WebhookMessage {
	event: WebhookEvent;
	target: { url: string; secrets: string[] };
}

export const WEBHOOK_DELIVERY_PREFIX = "webhook-delivery:";
const DELIVERY_LOG_TTL_SECONDS = 7 * 24 * 60 * 60;
const ATTEMPT_TIMEOUT_MS = 15_000;
/** Delay before each retry: 30 s, 2 min, 10 min, 1 h, then 6 h. */
export const WEBHOOK_RETRY_DELAYS_SECONDS = [30, 120, 600, 3600, 21600];
/** Tries per event, the first one included. After the last, it goes to the dead-letter queue. */
export const MAX_WEBHOOK_ATTEMPTS = 8;

export type DeliveryStatus = "delivered" | "retrying" | "failed" | "dead-lettered";

/** What the delivery log keeps of an event. */
export interface DeliveryRecord {
	eventId: string;
	type: string;
	url: string;
	status: DeliveryStatus;
	attempts: number;
	/** HTTP status of the last attempt, when it got a response. */
	responseStatus?: number;
	error?: string;
	updatedAt: string;
}

type AttemptResult = { ok: true; responseStatus: number } | { ok: false; responseStatus?: number; error: string };

type DeliveryEnv = Pick<WorkerEnv, "MEDIA_KV" | "WEBHOOK_DLQ">;

async function postSigned(message: WebhookMessage): Promise<AttemptResult> {
	const body = JSON.stringify(message.event);
	const signature = await signWebhook({ id: message.event.id, payload: body, secret: message.target.secrets });
	try {
		const response = await fetch(message.target.url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...signature },
			body,
			// A redirect could point the request somewhere the URL check never saw.
			redirect: "manual",
			signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
		});
		await response.body?.cancel();
		if (response.ok) return { ok: true, responseStatus: response.status };
		return { ok: false, responseStatus: response.status, error: `HTTP ${response.status}` };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

async function logDelivery(
	env: DeliveryEnv,
	message: WebhookMessage,
	attempts: number,
	status: DeliveryStatus,
	result: AttemptResult,
): Promise<void> {
	const record: DeliveryRecord = {
		eventId: message.event.id,
		type: message.event.type,
		url: message.target.url,
		status,
		attempts,
		...(result.responseStatus !== undefined ? { responseStatus: result.responseStatus } : {}),
		...(result.ok ? {} : { error: result.error }),
		updatedAt: new Date().toISOString(),
	};
	try {
		await env.MEDIA_KV.put(`${WEBHOOK_DELIVERY_PREFIX}${message.event.id}`, JSON.stringify(record), {
			expirationTtl: DELIVERY_LOG_TTL_SECONDS,
		});
	} catch (error) {
		console.error("[media-webhook] delivery log write failed:", error);
	}
}

/** The delivery record of an event, while the log keeps it. */
export async function readDeliveryRecord(kv: KVNamespace, eventId: string): Promise<DeliveryRecord | null> {
	return kv.get<DeliveryRecord>(`${WEBHOOK_DELIVERY_PREFIX}${eventId}`, "json");
}

/** One attempt, without retries (no queue): logged as `delivered` or `failed`. */
export async function deliverOnce(env: DeliveryEnv, message: WebhookMessage): Promise<boolean> {
	const result = await postSigned(message);
	if (!result.ok) console.error(`[media-webhook] ${message.event.id} to ${message.target.url} failed: ${result.error}`);
	await logDelivery(env, message, 1, result.ok ? "delivered" : "failed", result);
	return result.ok;
}

/** Seconds before the retry that follows attempt number `attempt` (1-based). */
export function retryDelaySeconds(attempt: number): number {
	const index = Math.min(Math.max(attempt, 1), WEBHOOK_RETRY_DELAYS_SECONDS.length) - 1;
	return WEBHOOK_RETRY_DELAYS_SECONDS[index];
}

async function handleMessage(env: DeliveryEnv, message: Message<WebhookMessage>): Promise<void> {
	const attempt = message.attempts;
	const result = await postSigned(message.body);
	if (result.ok) {
		await logDelivery(env, message.body, attempt, "delivered", result);
		message.ack();
		return;
	}
	if (attempt < MAX_WEBHOOK_ATTEMPTS) {
		await logDelivery(env, message.body, attempt, "retrying", result);
		message.retry({ delaySeconds: retryDelaySeconds(attempt) });
		return;
	}
	console.error(`[media-webhook] ${message.body.event.id} gave up after ${attempt} attempts: ${result.error}`);
	await logDelivery(env, message.body, attempt, "dead-lettered", result);
	if (!env.WEBHOOK_DLQ) {
		// The queue's own `dead_letter_queue` takes it (with `max_retries = 7`, this retry is past the limit).
		message.retry();
		return;
	}
	await env.WEBHOOK_DLQ.send(message.body);
	message.ack();
}

/**
 * Queue consumer of `WEBHOOK_QUEUE`: export it as the Worker's `queue` handler. Each message is one event; a failed
 * attempt is retried after 30 s, 2 min, 10 min, 1 h, then every 6 h, and after the 8th it goes to `WEBHOOK_DLQ` (or the
 * queue's own dead-letter queue).
 */
export async function deliverWebhooks(batch: MessageBatch<WebhookMessage>, env: WorkerEnv): Promise<void> {
	await Promise.all(batch.messages.map((message) => handleMessage(env, message)));
}
