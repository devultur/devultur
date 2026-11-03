// Emitting media events from a route. A request's events are collected and handed off once, after the route (one
// `waitUntil`, one `sendBatch` per 100): to the plugins' `onMediaEvent` hooks when there are any (they replace the
// built-in delivery), else signed to their webhook, through `WEBHOOK_QUEUE` when bound. A failure is logged, never
// surfaced to the caller.
import {
	createWebhookEvent,
	type MediaChangedData,
	type MediaDeletedData,
	type MediaEvent,
	type WebhookEvent,
} from "@devultur/core";
import type { Context, MiddlewareHandler } from "hono";
import { inBackground } from "../background";
import { getPluginHooks } from "../plugin-hooks";
import { getRequestState, type WebhookConfig } from "../request-state";
import type { WorkerApp, WorkerEnv } from "../types";
import { deliverOnce, logDropped, type WebhookMessage } from "./delivery";
import { toWebhookTarget, unsafeUrlReason, type WebhookTarget, webhookTargetOf } from "./target";

type EmitContext = Context<WorkerApp>;
type DeliveryEnv = Pick<WorkerEnv, "MEDIA_KV" | "WEBHOOK_QUEUE" | "WEBHOOK_DLQ">;

/** Messages per `sendBatch` (the Queues limit). */
const QUEUE_BATCH_LIMIT = 100;
/**
 * Events delivered directly (no queue) per request or `sendMediaEvents` call: each costs a fetch and a KV write, and a
 * Worker invocation has a subrequest limit. The rest are logged as dropped: bind `WEBHOOK_QUEUE` for bulk changes.
 */
export const MAX_DIRECT_DELIVERIES = 10;

/** Context variable collecting the request's events until the route is done. Internal. */
export const MEDIA_EVENTS_VARIABLE = "mediaEvents";

export interface PendingMediaEvent {
	event: WebhookEvent;
	target: WebhookTarget | null;
}

const chunk = <T>(items: T[], size: number): T[][] =>
	Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

const isLifecycle = (event: WebhookEvent) => event.type === "media.deleted" || event.type === "media.changed";

/** How many direct deliveries are left to spend. */
interface DirectBudget {
	remaining: number;
}

/** Hands `events` to `target`: queued (by scope) with `WEBHOOK_QUEUE`, otherwise one attempt each, within `budget`. */
export async function sendToTarget(
	env: DeliveryEnv,
	target: WebhookTarget,
	events: WebhookEvent[],
	budget: DirectBudget = { remaining: MAX_DIRECT_DELIVERIES },
): Promise<void> {
	const unsafe = unsafeUrlReason(target.url, target.allowUnsafeUrl);
	if (unsafe) {
		console.error(`[media-webhook] not sent to ${target.url}: ${unsafe}`);
		return;
	}
	const wanted = events.filter((event) => target.events.includes(event.type));
	if (wanted.length === 0) return;
	const queue = env.WEBHOOK_QUEUE;
	if (queue) {
		const messages: WebhookMessage[] = wanted.map((event) => ({ event, scope: target.scope }));
		for (const batch of chunk(messages, QUEUE_BATCH_LIMIT)) await queue.sendBatch(batch.map((body) => ({ body })));
		return;
	}
	const now = wanted.slice(0, budget.remaining);
	budget.remaining -= now.length;
	const dropped = wanted.slice(now.length);
	if (dropped.length > 0) {
		console.error(
			`[media-webhook] ${dropped.length} events to ${target.url} dropped: bind WEBHOOK_QUEUE for bulk changes`,
		);
	}
	await Promise.all([
		...now.map((event) => deliverOnce(env, event, target)),
		...dropped.map((event) => logDropped(env, event, target)),
	]);
}

async function runHooks(context: EmitContext, pending: PendingMediaEvent[]): Promise<void> {
	const hooks = getPluginHooks(context).onMediaEvent;
	const wanted = pending.filter(({ event, target }) => isLifecycle(event) || target?.events.includes(event.type));
	const runs = wanted.flatMap(({ event }) => hooks.map((hook) => Promise.resolve().then(() => hook(context, event))));
	for (const result of await Promise.allSettled(runs)) {
		if (result.status === "rejected") console.error("[media-webhook] onMediaEvent hook failed:", result.reason);
	}
}

/** The events of each target, in order: one batch per scope. */
function byTarget(pending: PendingMediaEvent[]): Array<{ target: WebhookTarget; events: WebhookEvent[] }> {
	const groups = new Map<string, { target: WebhookTarget; events: WebhookEvent[] }>();
	for (const { event, target } of pending) {
		if (!target) continue;
		const group = groups.get(target.scope) ?? { target, events: [] };
		group.events.push(event);
		groups.set(target.scope, group);
	}
	return [...groups.values()];
}

async function deliver(context: EmitContext, pending: PendingMediaEvent[]): Promise<void> {
	try {
		if (getPluginHooks(context).onMediaEvent.length > 0) {
			await runHooks(context, pending);
			return;
		}
		const budget = { remaining: MAX_DIRECT_DELIVERIES };
		for (const { target, events } of byTarget(pending)) await sendToTarget(context.env, target, events, budget);
	} catch (error) {
		console.error("[media-webhook] delivery failed:", error);
	}
}

/** Middleware of `createWorker()`: collects the request's events and hands them off once, after the route. */
export const collectMediaEvents: MiddlewareHandler<WorkerApp> = async (context, next) => {
	const pending: PendingMediaEvent[] = [];
	context.set(MEDIA_EVENTS_VARIABLE, pending);
	await next();
	if (pending.length > 0) await inBackground(context, deliver(context, pending.splice(0)));
};

export interface EmitOptions {
	/** Where to send them. Default: the request's scope (`config.webhooks`, else the `MEDIA_WEBHOOK_*` vars). */
	target?: WebhookTarget | null;
}

/** Emits `events`: collected until the route is done (outside `createWorker()`, handed off right away). */
export async function emitMediaEvents(
	context: EmitContext,
	events: WebhookEvent[],
	options: EmitOptions = {},
): Promise<void> {
	if (events.length === 0) return;
	const target =
		options.target !== undefined ? options.target : webhookTargetOf(getRequestState(context).config, context.env);
	const pending = events.map((event) => ({ event, target }));
	const collected = context.get(MEDIA_EVENTS_VARIABLE) as PendingMediaEvent[] | undefined;
	if (collected) {
		collected.push(...pending);
		return;
	}
	await inBackground(context, deliver(context, pending));
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
 * sweeper): to `webhooks` (with its `scope`: it throws without one), else the `MEDIA_WEBHOOK_*` vars. Plugin hooks don't run here: call your own instead. Without
 * `WEBHOOK_QUEUE`, at most `MAX_DIRECT_DELIVERIES` per call are delivered. Await it, or hand it to `ctx.waitUntil`.
 */
export async function sendMediaEvents(
	env: WorkerEnv,
	events: WebhookEvent[],
	options: { webhooks?: WebhookConfig } = {},
): Promise<void> {
	const target = options.webhooks ? toWebhookTarget(options.webhooks) : webhookTargetOf(undefined, env);
	if (!target || events.length === 0) return;
	await sendToTarget(env, target, events);
}
