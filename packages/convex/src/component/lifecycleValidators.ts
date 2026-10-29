// Validators of the media lifecycle events (`media.deleted`, `media.changed` from `@devultur/core`), and the copy of
// an event with only the fields they declare: Convex validates arguments strictly, and a field a newer Worker adds
// must not turn a valid event into a rejected one.
import type { MediaLifecycleEvent } from "@devultur/core";
import { type Infer, v } from "convex/values";
import { objectLockValidator } from "./lockValidators";

const envelopeFields = {
	id: v.string(),
	occurredAt: v.string(),
	apiVersion: v.literal(1),
};

export const mediaDeletedEventValidator = v.object({
	...envelopeFields,
	type: v.literal("media.deleted"),
	data: v.object({
		key: v.string(),
		mediaId: v.string(),
		kind: v.union(v.literal("image"), v.literal("video"), v.literal("file"), v.literal("asset")),
		visibility: v.union(v.literal("public"), v.literal("private")),
		reason: v.union(
			v.literal("api"),
			v.literal("prefix"),
			v.literal("purge"),
			v.literal("expired"),
			v.literal("raw-retention"),
		),
		retainedCount: v.optional(v.number()),
	}),
});

export const mediaChangedEventValidator = v.object({
	...envelopeFields,
	type: v.literal("media.changed"),
	data: v.object({
		key: v.string(),
		mediaId: v.string(),
		changes: v.array(
			v.union(v.literal("lock"), v.literal("hold"), v.literal("replaced"), v.literal("original-deleted")),
		),
		lock: v.optional(objectLockValidator),
		etag: v.string(),
	}),
});

export const lifecycleEventValidator = v.union(mediaDeletedEventValidator, mediaChangedEventValidator);

export type MediaDeletedEventArgs = Infer<typeof mediaDeletedEventValidator>;
export type MediaChangedEventArgs = Infer<typeof mediaChangedEventValidator>;
export type LifecycleEventArgs = Infer<typeof lifecycleEventValidator>;

const defined = <T extends Record<string, unknown>>(fields: T) =>
	Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;

function lockArgs(lock: NonNullable<MediaChangedEventArgs["data"]["lock"]>) {
	const { retention } = lock;
	return defined({
		hold: lock.hold,
		retention: retention
			? defined({
					mode: retention.mode,
					until: retention.until,
					period: retention.period,
					derivatives: retention.derivatives,
				})
			: undefined,
	});
}

/** `event` with only the fields the validators declare. */
export function lifecycleEventArgs(event: MediaLifecycleEvent): LifecycleEventArgs {
	const envelope = { id: event.id, occurredAt: event.occurredAt, apiVersion: 1 as const };
	if (event.type === "media.deleted") {
		const { key, mediaId, kind, visibility, reason, retainedCount } = event.data;
		const data = defined({ key, mediaId, kind, visibility, reason, retainedCount });
		return { ...envelope, type: event.type, data };
	}
	const { key, mediaId, changes, lock, etag } = event.data;
	const data = defined({ key, mediaId, changes, etag, lock: lock ? lockArgs(lock) : undefined });
	return { ...envelope, type: event.type, data };
}
