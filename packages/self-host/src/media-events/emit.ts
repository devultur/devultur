// Emitting media events from a route: to the plugins' `onMediaEvent` hooks when there are any (they replace the
// built-in delivery), else signed to the scope's webhook, through `WEBHOOK_QUEUE` when bound. Everything runs after the
// response; a failure is logged, never surfaced to the caller.
import {
	createWebhookEvent,
	type MediaChangedData,
	type MediaDeletedData,
	type MediaEvent,
	type WebhookEvent,
} from "@devultur/core";
import type { Context } from "hono";
import { inBackground } from "../background";
import { getPluginHooks } from "../plugin-hooks";
import { getRequestState, type WebhookConfig } from "../request-state";
import type { WorkerApp, WorkerEnv } from "../types";
import { deliverOnce, type WebhookMessage } from "./delivery";
import { resolveWebhookTarget, toWebhookTarget, unsafeUrlReason, type WebhookTarget } from "./target";

type EmitContext = Context<WorkerApp>;

/** Messages per `sendBatch` (the Queues limit). */
const QUEUE_BATCH_LIMIT = 100;

const chunk = <T>(items: T[], size: number): T[][] =>
	Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

const isLifecycle = (event: WebhookEvent) => event.type === "media.deleted" || event.type === "media.changed";

/** Hands `events` to `target`: queued when the Worker has `WEBHOOK_QUEUE`, otherwise one attempt each, now. */
export async function sendToTarget(
	env: Pick<WorkerEnv, "MEDIA_KV" | "WEBHOOK_QUEUE" | "WEBHOOK_DLQ">,
	target: WebhookTarget,
	events: WebhookEvent[],
): Promise<void> {
	const unsafe = unsafeUrlReason(target.url, target.allowUnsafeUrl);
	if (unsafe) {
		console.error(`[media-webhook] not sent to ${target.url}: ${unsafe}`);
		return;
	}
	const messages: WebhookMessage[] = events
		.filter((event) => target.events.includes(event.type))
		.map((event) => ({ event, target: { url: target.url, secrets: target.secrets } }));
	if (messages.length === 0) return;
	const queue = env.WEBHOOK_QUEUE;
	if (queue) {
		const batches = chunk(messages, QUEUE_BATCH_LIMIT);
		await Promise.all(batches.map((batch) => queue.sendBatch(batch.map((body) => ({ body })))));
		return;
	}
	await Promise.all(messages.map((message) => deliverOnce(env, message)));
}

async function runHooks(context: EmitContext, events: WebhookEvent[]): Promise<void> {
	const hooks = getPluginHooks(context).onMediaEvent;
	const runs = events.flatMap((event) => hooks.map((hook) => Promise.resolve().then(() => hook(context, event))));
	for (const result of await Promise.allSettled(runs)) {
		if (result.status === "rejected") console.error("[media-webhook] onMediaEvent hook failed:", result.reason);
	}
}

async function deliver(context: EmitContext, events: WebhookEvent[], target: WebhookTarget | null): Promise<void> {
	try {
		if (getPluginHooks(context).onMediaEvent.length > 0) {
			const wanted = events.filter((event) => isLifecycle(event) || target?.events.includes(event.type));
			await runHooks(context, wanted);
			return;
		}
		if (target) await sendToTarget(context.env, target, events);
	} catch (error) {
		console.error("[media-webhook] delivery failed:", error);
	}
}

export interface EmitOptions {
	/** Where to send them. Default: the request's scope (`config.webhooks`, else the `MEDIA_WEBHOOK_*` vars). */
	target?: WebhookTarget | null;
}

/** Emits `events` after the response. */
export async function emitMediaEvents(
	context: EmitContext,
	events: WebhookEvent[],
	options: EmitOptions = {},
): Promise<void> {
	if (events.length === 0) return;
	const target =
		options.target !== undefined ? options.target : resolveWebhookTarget(getRequestState(context).config, context.env);
	await inBackground(context, deliver(context, events, target));
}

export function emitMediaDeleted(context: EmitContext, data: MediaDeletedData, options?: EmitOptions): Promise<void> {
	return emitMediaEvents(context, [createWebhookEvent("media.deleted", data)], options);
}

export function emitMediaChanged(context: EmitContext, data: MediaChangedData, options?: EmitOptions): Promise<void> {
	return emitMediaEvents(context, [createWebhookEvent("media.changed", data)], options);
}

/** A transcode or captions event, in the envelope, for an endpoint that opted in to it. */
export function emitProcessingEvent(context: EmitContext, event: MediaEvent, options?: EmitOptions): Promise<void> {
	return emitMediaEvents(context, [createWebhookEvent(event.event, event)], options);
}

/**
 * Sends events from the Worker's own code, outside a request (the `onDeleted` of `deletePrefixRespectingLocks`, a
 * sweeper): to `webhooks`, else the `MEDIA_WEBHOOK_*` vars. Plugin hooks don't run here: call your own instead. Await
 * it, or hand it to `ctx.waitUntil`.
 */
export async function sendMediaEvents(
	env: WorkerEnv,
	events: WebhookEvent[],
	options: { webhooks?: WebhookConfig } = {},
): Promise<void> {
	const target = options.webhooks ? toWebhookTarget(options.webhooks) : resolveWebhookTarget(undefined, env);
	if (!target || events.length === 0) return;
	await sendToTarget(env, target, events);
}
