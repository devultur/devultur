// The lock of a stored object, read straight from the buckets: no request, no storage prefix of its own. For code that
// runs inside a Worker built on this package (a plugin route, a scheduled sweeper) and touches R2 directly. Same
// resolution as the guard: the upload lock or the version-bound sidecar, unreadable records held, a video's files
// inheriting from its raws. Image variants and mezzanines follow their original here: the Worker only ever deletes
// them with it.
import type { RetentionMode } from "@devultur/core";
import { isVariantKey } from "../image/transform-plan";
import { findLockedOriginal, type LockedOriginal, type LockSubject, lockSubjectOf } from "./guard";
import { LOCK_SIDECAR_PREFIX } from "./sidecar";
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
	/** Storage key of the original the lock belongs to, when it isn't the object itself (a video's raw, say). */
	lockedBy?: string;
}

export interface LockLookupOptions {
	mediaBucket: R2Bucket;
	/**
	 * The storage prefix the keys live under (the Worker's `storagePrefix`, `""` for the bucket root). Omitted: read
	 * from each key, as everything before its first `public/` or `private/` segment. Pass it when a prefix of yours
	 * has a segment named `public` or `private`.
	 */
	root?: string;
	/** Default: now. */
	now?: Date;
}

/** A storage key split into the storage prefix it lives under and the Worker's virtual key. */
export interface SplitKey {
	root: string;
	key: string;
}

const FIRST_SEGMENTS = new Set(["public", "private", LOCK_SIDECAR_PREFIX.slice(0, -1), "__lock-audit"]);

/** `null` when `storageKey` isn't under the `root` given. */
export function splitStorageKey(storageKey: string, root?: string): SplitKey | null {
	if (root !== undefined) {
		return storageKey.startsWith(root) ? { root, key: storageKey.slice(root.length) } : null;
	}
	const segments = storageKey.split("/");
	const first = segments.findIndex((segment) => FIRST_SEGMENTS.has(segment));
	if (first <= 0) return { root: "", key: storageKey };
	const inferredRoot = `${segments.slice(0, first).join("/")}/`;
	return { root: inferredRoot, key: storageKey.slice(inferredRoot.length) };
}

const VARIANTS_SEGMENT = "/__variants/";

/** What decides whether `key` (virtual) may go: like `lockSubjectOf`, but a variant follows its original. */
function retentionSubjectOf(key: string): NonNullable<LockSubject> {
	const original = isVariantKey(key) ? key.slice(0, key.indexOf(VARIANTS_SEGMENT)) : key;
	return lockSubjectOf(original) ?? { kind: "original", key: original };
}

export function toStoredObjectLock(locked: LockedOriginal | null, split: SplitKey): StoredObjectLock {
	if (!locked) return { locked: false, hold: false };
	const { lock, isUnreadable } = locked.state;
	const until = untilOf(locked.state);
	return {
		locked: true,
		hold: lock.hold === true,
		...(until ? { until } : {}),
		...(lock.retention ? { mode: lock.retention.mode } : {}),
		...(isUnreadable ? { unreadable: true as const } : {}),
		...(locked.key === split.key ? {} : { lockedBy: `${split.root}${locked.key}` }),
	};
}

/** Resolves locks of many objects, reading each original (or video's raws) once. */
export function lockResolver(mediaBucket: R2Bucket, now: Date) {
	const resolved = new Map<string, Promise<LockedOriginal | null>>();
	return (split: SplitKey): Promise<LockedOriginal | null> => {
		const subject = retentionSubjectOf(split.key);
		const id = `${split.root}\u0000${subject.kind === "original" ? subject.key : subject.rawPrefix}`;
		const cached = resolved.get(id);
		if (cached) return cached;
		const pending = findLockedOriginal(mediaBucket, split.root, subject, now);
		resolved.set(id, pending);
		return pending;
	};
}

/**
 * The lock in force on the object at `storageKey` (the full R2 key), or `null` when there's no such object. A file
 * under a video's folder (an HLS segment, a caption) is locked by the video's raws unless they're `original-only`;
 * an image variant by its original.
 */
export async function readObjectLock(options: LockLookupOptions, storageKey: string): Promise<StoredObjectLock | null> {
	const split = splitStorageKey(storageKey, options.root);
	if (!split) return null;
	if (!(await options.mediaBucket.head(storageKey))) return null;
	const locked = await lockResolver(options.mediaBucket, options.now ?? new Date())(split);
	return toStoredObjectLock(locked, split);
}
