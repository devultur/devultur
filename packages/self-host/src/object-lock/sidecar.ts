// Lock sidecar: the current lock of an object after any change made through `PUT /v1/lock` (later: holds), at
// `{storagePrefix}__lock/{virtualKey}` in the media bucket. The upload's `customMetadata.lock` can't be edited in place
// (R2 metadata is fixed per write), so the sidecar takes over once it exists. It's bound to the object version it was
// written for (`objectVersion`, R2's per-write `version`; never the etag, which is the content's MD5 and repeats when
// the same bytes are uploaded again): an object replaced after its lock ended starts fresh from its own upload lock,
// and a stale sidecar is ignored. That binding is what retires a sidecar: deleting or overwriting the object leaves it
// in place, inert (deleting it then could delete one a lock change just wrote for the new object). Writes are
// compare-and-swap on the sidecar's etag, so two concurrent changes can't both land on the same revision.
import { isIsoInstant, type ObjectLock, validateLock } from "@devultur/core";
import { type LockState, lockStateOf } from "./state";

export const LOCK_SIDECAR_PREFIX = "__lock/";

export interface LockSidecar {
	/** Increases by one on every change. */
	revision: number;
	/** The object version this lock applies to (see `objectVersionOf`). */
	objectVersion: string;
	lock: ObjectLock;
	/** ISO time the hold was released (a `period` then counts from here). */
	holdReleasedAt?: string;
	/** ISO time of the last change. */
	updatedAt: string;
}

export interface StoredSidecar {
	sidecar: LockSidecar;
	/** The sidecar object's own etag, for the next compare-and-swap. */
	etag: string;
	/** The record couldn't be read: `sidecar` is a stand-in hold bound to any version (see `readSidecar`). */
	isUnreadable?: true;
}

export type LockSource = "sidecar" | "upload" | "none";

export interface EffectiveLock {
	state: LockState | null;
	source: LockSource;
	stored: StoredSidecar | null;
}

type LockedObject = Pick<R2Object, "customMetadata" | "etag"> & { uploaded?: Date; version?: string };

/** Identifies one write of an object: R2's `version`, or its etag and upload time when a binding has none. */
export function objectVersionOf(object: LockedObject): string {
	return object.version ?? `${object.etag}@${object.uploaded?.toISOString() ?? ""}`;
}

export const sidecarKey = (root: string, key: string) => `${root}${LOCK_SIDECAR_PREFIX}${key}`;

function parseSidecar(raw: string): LockSidecar | null {
	try {
		const parsed = JSON.parse(raw) as Partial<LockSidecar>;
		const lock = validateLock(parsed.lock);
		if (!lock.ok || typeof parsed.revision !== "number" || typeof parsed.objectVersion !== "string") return null;
		// A release time that isn't a date would make the period's end unknowable: unreadable, so it fails closed.
		if (parsed.holdReleasedAt !== undefined && !isIsoInstant(parsed.holdReleasedAt)) return null;
		return { ...(parsed as LockSidecar), lock: lock.lock };
	} catch {
		return null;
	}
}

/**
 * The sidecar of `key`. An unreadable one fails closed: read as a hold bound to any version (`objectVersion: "*"`),
 * which the API can't release or change (it might stand for a compliance retention): `lock_record_unreadable`.
 */
export async function readSidecar(bucket: R2Bucket, root: string, key: string): Promise<StoredSidecar | null> {
	const object = await bucket.get(sidecarKey(root, key));
	if (!object) return null;
	const sidecar = parseSidecar(await object.text());
	if (sidecar) return { sidecar, etag: object.etag };
	const unreadable: LockSidecar = { revision: 0, objectVersion: "*", lock: { hold: true }, updatedAt: "" };
	return { sidecar: unreadable, etag: object.etag, isUnreadable: true };
}

/**
 * Writes the next revision, only if the sidecar is still the one `previous` read (create-only when there was none).
 * `false`: someone else changed it first; nothing was written.
 */
export async function writeSidecar(
	bucket: R2Bucket,
	root: string,
	key: string,
	sidecar: LockSidecar,
	previous: StoredSidecar | null,
): Promise<boolean> {
	const onlyIf: R2Conditional | Headers = previous
		? { etagMatches: previous.etag }
		: new Headers({ "If-None-Match": "*" });
	const stored = await bucket.put(sidecarKey(root, key), JSON.stringify(sidecar), {
		onlyIf,
		httpMetadata: { contentType: "application/json" },
	});
	return stored !== null;
}

/** The lock in force on `object` (virtual `key` under `root`): its sidecar when it applies, else the upload lock. */
export async function effectiveLock(
	bucket: R2Bucket,
	root: string,
	key: string,
	object: LockedObject,
): Promise<EffectiveLock> {
	const stored = await readSidecar(bucket, root, key);
	const bound = stored?.sidecar.objectVersion;
	const applies = stored && (bound === "*" || bound === objectVersionOf(object));
	if (stored && applies) {
		const { lock, holdReleasedAt } = stored.sidecar;
		const state: LockState = {
			lock,
			...(object.uploaded ? { uploadedAt: object.uploaded } : {}),
			...(holdReleasedAt ? { holdReleasedAt: new Date(holdReleasedAt) } : {}),
			...(stored.isUnreadable ? { isUnreadable: true as const } : {}),
		};
		return { state, source: "sidecar", stored };
	}
	const state = lockStateOf(object);
	return { state, source: state ? "upload" : "none", stored };
}

/**
 * `409 lock_record_unreadable` when `state`'s lock record can't be read: its stand-in hold can't be released and its
 * retention can't be set through the API, since the real record might hold a compliance retention. `null` otherwise.
 */
export function unreadableLockRefusal(state: LockState | null, key: string): Response | null {
	if (!state?.isUnreadable) return null;
	return Response.json(
		{
			error: `The lock record of ${key} can't be read; it stays held until an operator repairs it`,
			code: "lock_record_unreadable",
			key,
		},
		{ status: 409 },
	);
}

const VIDEO_STORAGE_KEY = /^(.*?)((?:public|private)\/video\/[^/]+\/.+)$/;

/** Splits a video object's storage key into its storage prefix and virtual key (`null` if it isn't one). */
export function splitVideoStorageKey(storageKey: string): { root: string; key: string } | null {
	const match = VIDEO_STORAGE_KEY.exec(storageKey);
	return match ? { root: match[1] ?? "", key: match[2] ?? "" } : null;
}
