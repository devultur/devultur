// The lock an object was uploaded with: its own R2 `customMetadata.lock`, written in the same `put` (or multipart
// create) as the bytes, so an object never exists unprotected. Later changes live in a sidecar (sidecar.ts), and
// `effectiveLock` there picks whichever is in force.
import { effectiveUntil, isLocked, type ObjectLock, type ResolvedLock, validateLock } from "@devultur/core";

/** `customMetadata` key holding the lock set at upload (JSON `{ retention?, hold }`). Owned by the Worker. */
export const LOCK_METADATA_KEY = "lock";

export interface LockState {
	lock: ObjectLock;
	/** `R2Object.uploaded`: a `retention.period` without a hold counts from here. */
	uploadedAt?: Date;
	/** When the hold was released (from the sidecar): the period counts from here instead. */
	holdReleasedAt?: Date;
	/**
	 * The stored lock couldn't be read, so `lock` is a stand-in hold (fail closed). What it really said is unknown, so
	 * the API can't change it: the hold can't be released, nor the retention set, until an operator repairs the record.
	 */
	isUnreadable?: true;
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
	return readLockMetadata(raw)?.lock;
}

function readLockMetadata(raw: string | undefined): { lock: ObjectLock; isUnreadable: boolean } | undefined {
	if (raw === undefined) return undefined;
	try {
		const validation = validateLock(JSON.parse(raw));
		if (validation.ok) return { lock: validation.lock, isUnreadable: false };
	} catch {}
	return { lock: { hold: true }, isUnreadable: true };
}

type LockedObject = Pick<R2Object, "customMetadata"> & { uploaded?: Date };

/** Lock state of an object already read (`head`/`list` with metadata). `null` if it carries no lock. */
export function lockStateOf(object: LockedObject): LockState | null {
	const stored = readLockMetadata(object.customMetadata?.[LOCK_METADATA_KEY]);
	if (!stored) return null;
	return {
		lock: stored.lock,
		...(object.uploaded ? { uploadedAt: object.uploaded } : {}),
		...(stored.isUnreadable ? { isUnreadable: true as const } : {}),
	};
}

/** True while the state forbids delete and overwrite. A period with no known start fails closed (locked). */
export function isStateLocked(state: LockState, now: Date): boolean {
	try {
		return isLocked(state.lock, now, { uploadedAt: state.uploadedAt, holdReleasedAt: state.holdReleasedAt });
	} catch {
		return true;
	}
}

/** ISO time the retention ends, or `undefined` when it has none or a hold keeps its `period` from starting. */
export function untilOf(state: LockState): string | undefined {
	try {
		return effectiveUntil(state.lock, { uploadedAt: state.uploadedAt, holdReleasedAt: state.holdReleasedAt });
	} catch {
		return undefined;
	}
}
