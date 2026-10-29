// Media lifecycle events: what happened to a stored object after its upload (deleted, its lock changed, replaced,
// its original deleted after a transcode), in one envelope shared with the transcode and captions events a Worker can
// fan out to the same endpoint.
//
// Delivery is at least once and unordered. A receiver:
// - deduplicates by `id` (a retry carries the same one);
// - applies an event only when its `occurredAt` is newer than the last one it applied to that media (and, for a
//   `media.changed`, treats a different `etag` as another version of the object);
// - treats `media.deleted` as final, unless a later `media.changed` with `replaced` arrives (the key was written again).
import type { ObjectLock } from "./lock";
import type { DevulturKind, Visibility } from "./media";
import type { MediaEvent, MediaEventType } from "./types";

/** Version of the envelope and of the `data` shapes. A breaking change to either is a new version. */
export const WEBHOOK_API_VERSION = 1;

export const MediaLifecycleEventName = {
	DELETED: "media.deleted",
	CHANGED: "media.changed",
} as const;

export type MediaLifecycleEventType = (typeof MediaLifecycleEventName)[keyof typeof MediaLifecycleEventName];

/**
 * Why the media was deleted: `api` (`DELETE /v1/media/…`). From the Worker's own code, the reason its prefix delete
 * passes: `prefix` (the default), `purge` (a teardown of a whole storage prefix), `expired` (a sweeper of files whose
 * lifetime ran out). A video's original deleted after its transcode is a `media.changed` (`original-deleted`).
 */
export type MediaDeleteReason = "api" | "prefix" | "purge" | "expired";

/**
 * What changed: `lock` (its retention), `hold` (a hold set or released), `replaced` (new bytes at the same key),
 * `original-deleted` (a video's original, deleted after its transcode; the outputs stay).
 */
export type MediaChange = "lock" | "hold" | "replaced" | "original-deleted";

/** `asset`: a file under the client-chosen `asset/` namespace (its `mediaId` is its key). */
export type MediaEventKind = DevulturKind | "asset";

export interface MediaDeletedData {
	/** Virtual key of what was deleted (`{visibility}/{kind}/{id}/…`); for a whole video, its folder. */
	key: string;
	/** The media id (`DevulturMedia.id`); for an asset, its key. */
	mediaId: string;
	kind: MediaEventKind;
	visibility: Visibility;
	reason: MediaDeleteReason;
	/** Objects of the media that were kept because they're locked (a video folder deleted in part). */
	retainedCount?: number;
}

export interface MediaChangedData {
	/** Virtual key of the object that changed. */
	key: string;
	mediaId: string;
	changes: MediaChange[];
	/** The lock after the change, with `lock` or `hold`. */
	lock?: ObjectLock;
	/** Etag of the object after the change (of the deleted original, with `original-deleted`). */
	etag: string;
}

export interface WebhookEnvelope<Type extends string, Data> {
	/** `evt_<uuid>`. Unique per event, the same on every retry of it: deduplicate by it. */
	id: string;
	type: Type;
	/** ISO 8601 time the change happened. Order by it, never by arrival. */
	occurredAt: string;
	apiVersion: typeof WEBHOOK_API_VERSION;
	data: Data;
}

export type MediaDeletedEvent = WebhookEnvelope<"media.deleted", MediaDeletedData>;
export type MediaChangedEvent = WebhookEnvelope<"media.changed", MediaChangedData>;
export type MediaLifecycleEvent = MediaDeletedEvent | MediaChangedEvent;

/** A transcode or captions event, in the same envelope (only when the endpoint opts in to it). */
export type ProcessingWebhookEvent = WebhookEnvelope<MediaEventType, MediaEvent>;

export type WebhookEvent = MediaLifecycleEvent | ProcessingWebhookEvent;
export type WebhookEventType = WebhookEvent["type"];

/** The event of a given type: a lifecycle event's own shape, or a processing event's envelope. */
export type WebhookEventOf<Type extends WebhookEventType> = Type extends MediaLifecycleEventType
	? Extract<MediaLifecycleEvent, { type: Type }>
	: WebhookEnvelope<Type, MediaEvent>;

const EVENT_ID_PREFIX = "evt_";

/** A new event of `type`: a fresh `evt_<uuid>` id, `occurredAt` now (or the given time). */
export function createWebhookEvent<Type extends WebhookEventType>(
	type: Type,
	data: WebhookEventOf<Type>["data"],
	occurredAt: Date = new Date(),
): WebhookEventOf<Type> {
	const event = { id: `${EVENT_ID_PREFIX}${crypto.randomUUID()}`, type, occurredAt: occurredAt.toISOString() };
	return { ...event, apiVersion: WEBHOOK_API_VERSION, data } as WebhookEventOf<Type>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value` has the envelope's shape (it doesn't validate `data`). */
export function isWebhookEvent(value: unknown): value is WebhookEvent {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.type === "string" &&
		typeof value.occurredAt === "string" &&
		value.apiVersion === WEBHOOK_API_VERSION &&
		isRecord(value.data)
	);
}

export function isMediaLifecycleEvent(value: unknown): value is MediaLifecycleEvent {
	return isWebhookEvent(value) && (value.type === "media.deleted" || value.type === "media.changed");
}

/** The last event applied to a record: its `occurredAt`, and its `id` to break a tie between equal times. */
export interface AppliedEvent {
	occurredAt: string;
	id?: string;
}

/**
 * Whether `event` comes after the last one applied (`lastApplied`, or its `occurredAt` alone). Nothing applied yet:
 * true. Two events at the same time are ordered by `id`, so every receiver settles on the same one; the same event
 * again is not newer. Without the last one's id, an event at the same time counts as newer.
 */
export function isNewerEvent(
	event: Pick<WebhookEvent, "occurredAt" | "id">,
	lastApplied: AppliedEvent | string | undefined,
): boolean {
	if (!lastApplied) return true;
	const last = typeof lastApplied === "string" ? { occurredAt: lastApplied } : lastApplied;
	const difference = Date.parse(event.occurredAt) - Date.parse(last.occurredAt);
	if (difference !== 0) return difference > 0;
	return last.id === undefined || event.id > last.id;
}
