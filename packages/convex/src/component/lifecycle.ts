// Media lifecycle events from the Worker (`media.deleted`, `media.changed`), applied to the component's records.
// Delivery is at least once and unordered: an event is applied once (by id, remembered 7 days) and only when it's
// newer than the last one applied to its record. `media.deleted` removes the record and its captions; a
// `media.changed` patches the lock, the etag and `originalDeleted`. Also `missingKeys`, for an app's own references.
import { isNewerEvent } from "@devultur/core";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { type LifecycleEventArgs, lifecycleEventValidator, type MediaChangedEventArgs } from "./lifecycleValidators";
import { deleteMediaRecords } from "./mediaRecords";

export const PROCESSED_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Expired ids deleted per event: steady traffic keeps the table at about a week of events.
const PRUNE_BATCH = 20;
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

async function pruneProcessedEvents(ctx: MutationCtx, now: number): Promise<void> {
	const expired = await ctx.db
		.query("processedEvents")
		.withIndex("by_processed_at", (q) => q.lt("processedAt", now - PROCESSED_EVENT_TTL_MS))
		.take(PRUNE_BATCH);
	await Promise.all(expired.map((row) => ctx.db.delete(row._id)));
}

function changedFields(event: MediaChangedEventArgs): Partial<Doc<"media">> {
	const { changes, lock, etag } = event.data;
	const isLockChange = changes.includes("lock") || changes.includes("hold");
	return {
		...(isLockChange && lock ? { lock } : {}),
		...(changes.includes("original-deleted") ? { originalDeleted: true } : { etag }),
		lifecycleEventAt: event.occurredAt,
	};
}

async function applyToRecord(ctx: MutationCtx, event: LifecycleEventArgs): Promise<boolean> {
	const record = await findRecord(ctx, event.data.mediaId);
	if (!record || !isNewerEvent(event, record.lifecycleEventAt)) return false;
	if (event.type === "media.deleted") return deleteMediaRecords(ctx, record.key);
	await ctx.db.patch(record._id, changedFields(event));
	return true;
}

/**
 * Applies a lifecycle event to the component's records. `isDuplicate`: its id was already applied (nothing done).
 * `isApplied`: it changed a record (false when there's none, or a newer event was applied first).
 */
export const applyLifecycleEvent = mutation({
	args: { event: lifecycleEventValidator },
	handler: async (ctx, { event }) => {
		const seen = await ctx.db
			.query("processedEvents")
			.withIndex("by_event_id", (q) => q.eq("eventId", event.id))
			.first();
		if (seen) return { isDuplicate: true, isApplied: false };
		const now = Date.now();
		await ctx.db.insert("processedEvents", {
			eventId: event.id,
			type: event.type,
			mediaId: event.data.mediaId,
			occurredAt: event.occurredAt,
			processedAt: now,
		});
		await pruneProcessedEvents(ctx, now);
		return { isDuplicate: false, isApplied: await applyToRecord(ctx, event) };
	},
});

/**
 * Forgets that an event was processed, so its redelivery runs again: for when the app's own handling of it failed.
 * Its effect on the records stays (applying it again changes nothing).
 */
export const forgetLifecycleEvent = mutation({
	args: { eventId: v.string() },
	handler: async (ctx, { eventId }) => {
		const seen = await ctx.db
			.query("processedEvents")
			.withIndex("by_event_id", (q) => q.eq("eventId", eventId))
			.first();
		if (seen) await ctx.db.delete(seen._id);
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
