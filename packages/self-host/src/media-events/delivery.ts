// Delivering a media event: one signed POST per attempt, and a record of how it went in KV
// (`webhook-delivery:{eventId}`, 7 days). With a `WEBHOOK_QUEUE` the attempts are retried with backoff by the
// consumer (`deliverWebhooks`, or `createWebhookConsumer({ plugins })`); without one there's a single attempt after the
// response.
//
// A message names its target by scope only. Each attempt resolves the scope again and signs with the secrets in force
// then: a rotated or revoked secret takes effect for what's already queued, and no secret is ever written to a queue,
// KV or a log.
import { signWebhook, type WebhookEvent } from "@devultur/core";
import type { WorkerPlugin } from "../plugin";
import type { WorkerEnv } from "../types";
import { unsafeUrlReason, type WebhookTarget, type WebhookTargetResolver, webhookTargetOfScope } from "./target";

export interface WebhookMessage {
	event: WebhookEvent;
	/** The target's scope (`env`, `config`, or one a plugin resolves). */
	scope: string;
}

export const WEBHOOK_DELIVERY_PREFIX = "webhook-delivery:";
const DELIVERY_LOG_TTL_SECONDS = 7 * 24 * 60 * 60;
const ATTEMPT_TIMEOUT_MS = 15_000;
/** Delay before each retry: 30 s, 2 min, 10 min, 1 h, then 6 h. */
export const WEBHOOK_RETRY_DELAYS_SECONDS = [30, 120, 600, 3600, 21600];
/** Tries per event, the first one included. After the last, it goes to the dead-letter queue. */
export const MAX_WEBHOOK_ATTEMPTS = 8;

/**
 * `undeliverable`: no webhook resolves for its scope any more (or its URL is unsafe), so it's dropped. `dropped`: past
 * the direct-delivery cap of a request without a queue, never attempted.
 */
export type DeliveryStatus = "delivered" | "retrying" | "failed" | "dead-lettered" | "undeliverable" | "dropped";

/** What the delivery log keeps of an event. */
export interface DeliveryRecord {
	eventId: string;
	type: string;
	scope: string;
	/** The URL of the last attempt (none when the scope didn't resolve). */
	url?: string;
	status: DeliveryStatus;
	attempts: number;
	/** HTTP status of the last attempt, when it got a response. */
	responseStatus?: number;
	error?: string;
	updatedAt: string;
}

type AttemptResult = { ok: true; responseStatus: number } | { ok: false; responseStatus?: number; error: string };

type DeliveryEnv = Pick<WorkerEnv, "MEDIA_KV" | "WEBHOOK_DLQ">;

async function postSigned(event: WebhookEvent, target: WebhookTarget): Promise<AttemptResult> {
	const body = JSON.stringify(event);
	const signature = await signWebhook({ id: event.id, payload: body, secret: target.secrets });
	try {
		const response = await fetch(target.url, {
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

interface LogEntry {
	attempts: number;
	status: DeliveryStatus;
	result: AttemptResult;
	url?: string;
}

async function logDelivery(env: DeliveryEnv, message: WebhookMessage, entry: LogEntry): Promise<void> {
	const { result } = entry;
	const record: DeliveryRecord = {
		eventId: message.event.id,
		type: message.event.type,
		scope: message.scope,
		...(entry.url ? { url: entry.url } : {}),
		status: entry.status,
		attempts: entry.attempts,
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

/** One attempt to an already resolved target, without retries (no queue): logged as `delivered` or `failed`. */
export async function deliverOnce(env: DeliveryEnv, event: WebhookEvent, target: WebhookTarget): Promise<boolean> {
	const result = await postSigned(event, target);
	if (!result.ok) console.error(`[media-webhook] ${event.id} to ${target.url} failed: ${result.error}`);
	await logDelivery(
		env,
		{ event, scope: target.scope },
		{ attempts: 1, status: result.ok ? "delivered" : "failed", result, url: target.url },
	);
	return result.ok;
}

/** An event past the direct-delivery cap: never attempted, recorded as `dropped`. */
export async function logDropped(env: DeliveryEnv, event: WebhookEvent, target: WebhookTarget): Promise<void> {
	const result: AttemptResult = { ok: false, error: "over the direct-delivery cap: bind WEBHOOK_QUEUE" };
	await logDelivery(env, { event, scope: target.scope }, { attempts: 0, status: "dropped", result, url: target.url });
}

/** Seconds before the retry that follows attempt number `attempt` (1-based). */
export function retryDelaySeconds(attempt: number): number {
	const index = Math.min(Math.max(attempt, 1), WEBHOOK_RETRY_DELAYS_SECONDS.length) - 1;
	return WEBHOOK_RETRY_DELAYS_SECONDS[index];
}

type ScopeLookup = (scope: string) => Promise<WebhookTarget | null>;

async function handleMessage(env: DeliveryEnv, message: Message<WebhookMessage>, lookup: ScopeLookup): Promise<void> {
	const attempt = message.attempts;
	const { event, scope } = message.body;
	const target = await lookup(scope);
	const unsafe = target ? unsafeUrlReason(target.url, target.allowUnsafeUrl) : "no webhook for its scope";
	if (!target || unsafe) {
		console.error(`[media-webhook] ${event.id} (scope ${scope}) dropped: ${unsafe}`);
		await logDelivery(env, message.body, {
			attempts: attempt,
			status: "undeliverable",
			result: { ok: false, error: unsafe ?? "" },
		});
		message.ack();
		return;
	}
	const result = await postSigned(event, target);
	const logged = (status: DeliveryStatus) =>
		logDelivery(env, message.body, { attempts: attempt, status, result, url: target.url });
	if (result.ok) {
		await logged("delivered");
		message.ack();
		return;
	}
	if (attempt < MAX_WEBHOOK_ATTEMPTS) {
		await logged("retrying");
		message.retry({ delaySeconds: retryDelaySeconds(attempt) });
		return;
	}
	console.error(`[media-webhook] ${event.id} gave up after ${attempt} attempts: ${result.error}`);
	await logged("dead-lettered");
	if (!env.WEBHOOK_DLQ) {
		// The queue's own `dead_letter_queue` takes it (with `max_retries = 7`, this retry is past the limit).
		message.retry();
		return;
	}
	await env.WEBHOOK_DLQ.send(message.body);
	message.ack();
}

export interface WebhookConsumerOptions {
	/** The Worker's plugins: their `resolveWebhookTarget` (and `staticConfig`'s) resolve the scopes of the messages. */
	plugins?: readonly WorkerPlugin[];
}

/**
 * The queue consumer of `WEBHOOK_QUEUE`: export it as the Worker's `queue` handler, created with the same plugins as
 * the Worker so it resolves the same scopes. Each message is one event; a failed attempt is retried after 30 s, 2 min,
 * 10 min, 1 h, then every 6 h, and after the 8th it goes to `WEBHOOK_DLQ` (or the queue's own dead-letter queue). A
 * message whose scope no longer resolves is dropped (`undeliverable` in the delivery log).
 */
export function createWebhookConsumer(options: WebhookConsumerOptions = {}) {
	const resolvers: WebhookTargetResolver[] = (options.plugins ?? []).flatMap((plugin) =>
		plugin.resolveWebhookTarget ? [plugin.resolveWebhookTarget] : [],
	);
	return async (batch: MessageBatch<WebhookMessage>, env: WorkerEnv): Promise<void> => {
		// Resolved once per batch and scope: every message of the batch signs with the secrets in force now.
		const targets = new Map<string, Promise<WebhookTarget | null>>();
		const lookup: ScopeLookup = (scope) => {
			const cached = targets.get(scope) ?? webhookTargetOfScope(env, scope, resolvers);
			targets.set(scope, cached);
			return cached;
		};
		await Promise.all(batch.messages.map((message) => handleMessage(env, message, lookup)));
	};
}

/** The consumer for the `MEDIA_WEBHOOK_*` vars alone. With `config.webhooks`, use `createWebhookConsumer({ plugins })`. */
export const deliverWebhooks = createWebhookConsumer();
