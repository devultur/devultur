// Media lifecycle events from the Worker (`media.deleted`, `media.changed`), applied to the component's records.
// Delivery is at least once and unordered: an event is applied once (by id, remembered 7 days) and only when it's
// newer than the last one applied to its record, and than the record itself (a re-upload). `media.deleted` removes the
// record and its captions; a `media.changed` patches the lock, the etag and `originalDeleted`. Also `missingKeys`, for
// an app's own references.
//
// An app route (`registerDevulturWebhook`) runs its own handler after the component's mutation: the id is then
// `received` until the handler is done (`markLifecycleEventHandled`), and a redelivery of a `received` id runs the
// handler again. Applying an event to the records twice changes nothing.
import { isNewerEvent } from "@devultur/core";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { type LifecycleEventArgs, lifecycleEventValidator, type MediaChangedEventArgs } from "./lifecycleValidators";
import { deleteMediaRecords } from "./mediaRecords";

export const PROCESSED_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Expired ids deleted per run of the prune (crons.ts runs it hourly). */
export const PRUNE_BATCH = 500;
/** Runs one hourly prune may chain when each finds a full batch: at most 50,000 ids, then the next hour goes on. */
export const MAX_PRUNE_RUNS = 100;
/** Keys per `missingKeys` call: one index read each. */
export const MAX_MISSING_KEYS = 500;

async function findRecord(ctx: MutationCtx, mediaId: string): Promise<Doc<"media"> | null> {
	const record = await ctx.db
		.query("media")
		.withIndex("by_key", (q) => q.eq("key", mediaId))
		.first();
	if (record) return record;
	// Video records from before 1.0 are keyed `videos/{id}` (as `handleWebhookEvent` reads them).
	return ctx.db
		.query("media")
		.withIndex("by_key", (q) => q.eq("key", `videos/${mediaId}`))
		.first();
}

function changedFields(event: MediaChangedEventArgs): Partial<Doc<"media">> {
	const { changes, lock, etag } = event.data;
	const isLockChange = changes.includes("lock") || changes.includes("hold");
	return {
		...(isLockChange && lock ? { lock } : {}),
		...(changes.includes("original-deleted") ? { originalDeleted: true } : { etag }),
		lifecycleEventAt: event.occurredAt,
		lifecycleEventId: event.id,
	};
}

/** Whether `event` is about this record: newer than the last event applied to it, and not older than the record. */
function isCurrent(event: LifecycleEventArgs, record: Doc<"media">): boolean {
	// An event from before the record existed is about an earlier upload at the same key.
	if (Date.parse(event.occurredAt) < record.createdAt) return false;
	const lastApplied = record.lifecycleEventAt
		? { occurredAt: record.lifecycleEventAt, ...(record.lifecycleEventId ? { id: record.lifecycleEventId } : {}) }
		: undefined;
	return isNewerEvent(event, lastApplied);
}

async function applyToRecord(ctx: MutationCtx, event: LifecycleEventArgs): Promise<boolean> {
	const record = await findRecord(ctx, event.data.mediaId);
	if (!record || !isCurrent(event, record)) return false;
	if (event.type === "media.deleted") return deleteMediaRecords(ctx, record.key);
	await ctx.db.patch(record._id, changedFields(event));
	return true;
}

const processedEvent = (ctx: MutationCtx, eventId: string) =>
	ctx.db
		.query("processedEvents")
		.withIndex("by_event_id", (q) => q.eq("eventId", eventId))
		.first();

/**
 * Applies a lifecycle event to the component's records. `awaitsHandler`: an app handler runs after this, so the id
 * stays `received` until `markLifecycleEventHandled`. `isDuplicate`: the id was already handled (nothing done).
 * `isApplied`: it changed a record (false when there's none, it's stale, or it was applied before).
 */
export const applyLifecycleEvent = mutation({
	args: { event: lifecycleEventValidator, awaitsHandler: v.optional(v.boolean()) },
	handler: async (ctx, { event, awaitsHandler }) => {
		const status = awaitsHandler ? "received" : "handled";
		const seen = await processedEvent(ctx, event.id);
		if (seen?.status === "handled") return { isDuplicate: true, isApplied: false };
		if (seen && status === "handled") await ctx.db.patch(seen._id, { status });
		if (!seen) {
			await ctx.db.insert("processedEvents", {
				eventId: event.id,
				status,
				type: event.type,
				mediaId: event.data.mediaId,
				occurredAt: event.occurredAt,
				processedAt: Date.now(),
			});
		}
		return { isDuplicate: false, isApplied: await applyToRecord(ctx, event) };
	},
});

/** The app's handler of an event is done: a redelivery of its id is a duplicate from now on. */
export const markLifecycleEventHandled = mutation({
	args: { eventId: v.string() },
	handler: async (ctx, { eventId }) => {
		const seen = await processedEvent(ctx, eventId);
		if (seen) await ctx.db.patch(seen._id, { status: "handled" });
	},
});

/**
 * Deletes processed ids older than 7 days, `PRUNE_BATCH` at a time (crons.ts runs it hourly). A full batch means more
 * may be left: it schedules the next run right away, up to `MAX_PRUNE_RUNS` in a chain.
 */
export const pruneProcessedEvents = internalMutation({
	args: { run: v.optional(v.number()) },
	handler: async (ctx, { run = 1 }): Promise<number> => {
		const expired = await ctx.db
			.query("processedEvents")
			.withIndex("by_processed_at", (q) => q.lt("processedAt", Date.now() - PROCESSED_EVENT_TTL_MS))
			.take(PRUNE_BATCH);
		await Promise.all(expired.map((row) => ctx.db.delete(row._id)));
		if (expired.length === PRUNE_BATCH && run < MAX_PRUNE_RUNS) {
			await ctx.scheduler.runAfter(0, internal.lifecycle.pruneProcessedEvents, { run: run + 1 });
		}
		return expired.length;
	},
});

/** The keys (media ids) of `keys` that have no record, in their order, each once. At most 500 per call. */
export const missingKeys = query({
	args: { keys: v.array(v.string()) },
	handler: async (ctx, { keys }) => {
		const unique = [...new Set(keys)];
		if (unique.length > MAX_MISSING_KEYS) {
			throw new Error(`missingKeys takes at most ${MAX_MISSING_KEYS} keys per call; got ${unique.length}`);
		}
		const found = await Promise.all(
			unique.map((key) =>
				ctx.db
					.query("media")
					.withIndex("by_key", (q) => q.eq("key", key))
					.first(),
			),
		);
		return unique.filter((_key, index) => found[index] === null);
	},
});
