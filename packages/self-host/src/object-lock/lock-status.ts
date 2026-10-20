// The lock of a stored object, read straight from the buckets: no request, no storage prefix of its own. For code that
// runs inside a Worker built on this package (a plugin route, a scheduled sweeper) and touches R2 directly. Same
// resolution as the guard: the upload lock or the version-bound sidecar, unreadable records held, a video's files
// inheriting from its raws. An image's variants follow its lock unless it's `original-only`, like a video's files.
import type { RetentionMode } from "@devultur/core";
import { isVariantKey } from "../image/transform-plan";
import {
	findLockedOriginal,
	type LockedOriginal,
	type LockSubject,
	lockedObject,
	lockSubjectOf,
	protectsDerived,
} from "./guard";
import { untilOf } from "./state";

/** The lock in force on one stored object. */
export interface StoredObjectLock {
	/** True while the object can't be deleted or overwritten. */
	locked: boolean;
	/** A hold is set (an unreadable lock record reads as one). */
	hold: boolean;
	/** ISO time the retention ends; left out with no retention, or while a hold keeps a `period` from starting. */
	until?: string;
	mode?: RetentionMode;
	/** The lock record can't be read, so it's held until an operator repairs it. */
	unreadable?: true;
	/**
	 * The key isn't laid out like the Worker's (`{storage prefix}{public|private}/…`), so its lock record can't be
	 * found: it's kept, never deleted.
	 */
	unrecognized?: true;
	/** Storage key of the original the lock belongs to, when it isn't the object itself (a video's raw, say). */
	lockedBy?: string;
}

export interface LockLookupOptions {
	mediaBucket: R2Bucket;
	/**
	 * The storage prefix the keys live under (the Worker's `storagePrefix`, `""` for the bucket root). Omitted: read
	 * from each key, as everything before its first `public` or `private` segment. Pass it when a prefix of yours
	 * has a segment named `public` or `private`.
	 */
	root?: string;
	/** Default: now. */
	now?: Date;
}

/**
 * Where a storage key sits: a Worker object (its storage prefix and virtual key), a lock record or audit object
 * (`__lock` / `__lock-audit`, never touched), or a key laid out some other way (never deleted).
 */
export type KeyPlace = { kind: "object"; root: string; key: string } | { kind: "reserved" } | { kind: "unrecognized" };

export type ObjectPlace = Extract<KeyPlace, { kind: "object" }>;

const VISIBILITY_SEGMENTS = new Set(["public", "private"]);
// Any segment ending like a lock prefix: a storage prefix with no trailing `/` glues it to the segment before.
const RESERVED_SEGMENT = /__lock(?:-audit)?$/;

export function placeOfStorageKey(storageKey: string, root?: string): KeyPlace {
	const segments = storageKey.split("/");
	if (segments.some((segment) => RESERVED_SEGMENT.test(segment))) return { kind: "reserved" };
	if (root !== undefined) {
		const key = storageKey.slice(root.length);
		const isWorkerKey = storageKey.startsWith(root) && VISIBILITY_SEGMENTS.has(key.split("/")[0] ?? "");
		return isWorkerKey ? { kind: "object", root, key } : { kind: "unrecognized" };
	}
	const first = segments.findIndex((segment) => VISIBILITY_SEGMENTS.has(segment));
	if (first < 0) return { kind: "unrecognized" };
	const inferredRoot = first === 0 ? "" : `${segments.slice(0, first).join("/")}/`;
	return { kind: "object", root: inferredRoot, key: storageKey.slice(inferredRoot.length) };
}

export const UNRECOGNIZED_LOCK: StoredObjectLock = { locked: true, hold: false, unrecognized: true };

const VARIANTS_SEGMENT = "/__variants/";

/** What decides whether `key` (virtual) may go, and whether it's a variant (free under `original-only`). */
function retentionSubjectOf(key: string): { subject: NonNullable<LockSubject>; isVariant: boolean } {
	const isVariant = isVariantKey(key);
	const original = isVariant ? key.slice(0, key.indexOf(VARIANTS_SEGMENT)) : key;
	return { subject: lockSubjectOf(original) ?? { kind: "original", key: original }, isVariant };
}

export function toStoredObjectLock(locked: LockedOriginal | null, place: ObjectPlace): StoredObjectLock {
	if (!locked) return { locked: false, hold: false };
	const { lock, isUnreadable } = locked.state;
	const until = untilOf(locked.state);
	return {
		locked: true,
		hold: lock.hold === true,
		...(until ? { until } : {}),
		...(lock.retention ? { mode: lock.retention.mode } : {}),
		...(isUnreadable ? { unreadable: true as const } : {}),
		...(locked.key === place.key ? {} : { lockedBy: `${place.root}${locked.key}` }),
	};
}

/** A cached original's lock is read again after this many objects, or this long. */
export const LOCK_CACHE_MAX_USES = 50;
export const LOCK_CACHE_MAX_AGE_MS = 5000;

interface CachedLock {
	pending: Promise<LockedOriginal | null>;
	readAt: number;
	uses: number;
}

export type LockResolver = (place: ObjectPlace, object: R2Object) => Promise<LockedOriginal | null>;

/**
 * Resolves the lock in force on objects. An object's own lock is read on the version just read; the one it inherits
 * (a video's raws, an image's original) once per `LOCK_CACHE_MAX_USES` objects or `LOCK_CACHE_MAX_AGE_MS`.
 */
export function lockResolver(mediaBucket: R2Bucket, now: Date): LockResolver {
	const cache = new Map<string, CachedLock>();
	const resolveSubject = (root: string, subject: NonNullable<LockSubject>) => {
		const id = `${root}\u0000${subject.kind === "original" ? subject.key : subject.rawPrefix}`;
		const cached = cache.get(id);
		const isFresh = cached && cached.uses < LOCK_CACHE_MAX_USES && Date.now() - cached.readAt < LOCK_CACHE_MAX_AGE_MS;
		if (cached && isFresh) {
			cached.uses += 1;
			return cached.pending;
		}
		const pending = findLockedOriginal(mediaBucket, root, subject, now);
		// A failed read (a spent budget) isn't remembered: the next object reads again.
		pending.catch(() => cache.delete(id));
		cache.set(id, { pending, readAt: Date.now(), uses: 1 });
		return pending;
	};

	return async (place, object) => {
		const { subject, isVariant } = retentionSubjectOf(place.key);
		if (subject.kind === "original" && subject.key === place.key) {
			return lockedObject(mediaBucket, place.root, place.key, object, now);
		}
		const locked = await resolveSubject(place.root, subject);
		if (isVariant && subject.kind === "original" && locked && !protectsDerived(locked.state)) return null;
		return locked;
	};
}

/**
 * The lock in force on the object at `storageKey` (the full R2 key), or `null` when there's no such object (or it's
 * a lock record). A file under a video's folder (an HLS segment, a caption) is locked by the video's raws unless
 * they're `original-only`; an image variant by its original, likewise.
 */
export async function readObjectLock(options: LockLookupOptions, storageKey: string): Promise<StoredObjectLock | null> {
	const place = placeOfStorageKey(storageKey, options.root);
	if (place.kind === "reserved") return null;
	const object = await options.mediaBucket.head(storageKey);
	if (!object) return null;
	if (place.kind === "unrecognized") return UNRECOGNIZED_LOCK;
	const locked = await lockResolver(options.mediaBucket, options.now ?? new Date())(place, object);
	return toStoredObjectLock(locked, place);
}
