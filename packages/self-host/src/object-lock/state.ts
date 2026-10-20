// Where an object's lock lives and how it's read back. Today: the object's own R2 `customMetadata.lock`, written in
// the same `put` (or multipart create) as the bytes, so an object never exists unprotected. Later changes to a lock
// (extend, hold, release) go to a sidecar under `__lock/`; `readLockState` is the one seam that will merge it.
import { isLocked, type ObjectLock, type ResolvedLock, validateLock } from "@devultur/core";

/** `customMetadata` key holding the lock set at upload (JSON `{ retention?, hold }`). Owned by the Worker. */
export const LOCK_METADATA_KEY = "lock";

export interface LockState {
	lock: ObjectLock;
	/** `R2Object.uploaded`: a `retention.period` without a hold counts from here. */
	uploadedAt?: Date;
	/** When the hold was released (sidecar, not written yet): the period counts from here instead. */
	holdReleasedAt?: Date;
}

/** The lock to store, or `undefined` when there is nothing to enforce (no retention and no hold). */
export function encodeLockMetadata(lock: ResolvedLock | undefined): string | undefined {
	if (!lock || (!lock.retention && !lock.hold)) return undefined;
	return JSON.stringify(lock);
}

/**
 * The stored lock. A value that isn't a valid lock fails closed: it's read as a hold, since only the Worker writes this
 * key and an unreadable one must never free the object.
 */
export function parseLockMetadata(raw: string | undefined): ObjectLock | undefined {
	if (raw === undefined) return undefined;
	try {
		const validation = validateLock(JSON.parse(raw));
		if (validation.ok) return validation.lock;
	} catch {}
	return { hold: true };
}

type LockedObject = Pick<R2Object, "customMetadata"> & { uploaded?: Date };

/** Lock state of an object already read (`head`/`list` with metadata). `null` if it carries no lock. */
export function lockStateOf(object: LockedObject): LockState | null {
	const lock = parseLockMetadata(object.customMetadata?.[LOCK_METADATA_KEY]);
	if (!lock) return null;
	return { lock, ...(object.uploaded ? { uploadedAt: object.uploaded } : {}) };
}

/** Lock state of the object at `storageKey`. `null` if it doesn't exist or carries no lock. */
export async function readLockState(bucket: R2Bucket, storageKey: string): Promise<LockState | null> {
	const object = await bucket.head(storageKey);
	return object ? lockStateOf(object) : null;
}

/** True while the state forbids delete and overwrite. A period with no known start fails closed (locked). */
export function isStateLocked(state: LockState, now: Date): boolean {
	try {
		return isLocked(state.lock, now, { uploadedAt: state.uploadedAt, holdReleasedAt: state.holdReleasedAt });
	} catch {
		return true;
	}
}
