// Lock sidecar: the current lock of an object after any change made through `PUT /v1/lock` (later: holds), at
// `{storagePrefix}__lock/{virtualKey}` in the media bucket. The upload's `customMetadata.lock` can't be edited in place
// (R2 metadata is fixed per write), so the sidecar takes over once it exists. It's bound to the object version it was
// written for (`objectEtag`): an object replaced after its lock expired starts fresh from its own upload lock, and a
// stale sidecar is ignored. Writes are compare-and-swap on the sidecar's etag, so two concurrent changes can't both
// land on the same revision.
import { type ObjectLock, validateLock } from "@devultur/core";
import { type LockState, lockStateOf } from "./state";

export const LOCK_SIDECAR_PREFIX = "__lock/";

export interface LockSidecar {
	/** Increases by one on every change. */
	revision: number;
	/** Etag of the object version this lock applies to. */
	objectEtag: string;
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
}

export type LockSource = "sidecar" | "upload" | "none";

export interface EffectiveLock {
	state: LockState | null;
	source: LockSource;
	stored: StoredSidecar | null;
}

type LockedObject = Pick<R2Object, "customMetadata" | "etag"> & { uploaded?: Date };

export const sidecarKey = (root: string, key: string) => `${root}${LOCK_SIDECAR_PREFIX}${key}`;

function parseSidecar(raw: string): LockSidecar | null {
	try {
		const parsed = JSON.parse(raw) as Partial<LockSidecar>;
		const lock = validateLock(parsed.lock);
		if (!lock.ok || typeof parsed.revision !== "number" || typeof parsed.objectEtag !== "string") return null;
		return { ...(parsed as LockSidecar), lock: lock.lock };
	} catch {
		return null;
	}
}

/** The sidecar of `key`. An unreadable one fails closed: read as a hold bound to no version (`objectEtag: "*"`). */
export async function readSidecar(bucket: R2Bucket, root: string, key: string): Promise<StoredSidecar | null> {
	const object = await bucket.get(sidecarKey(root, key));
	if (!object) return null;
	const sidecar = parseSidecar(await object.text());
	if (sidecar) return { sidecar, etag: object.etag };
	const unreadable: LockSidecar = { revision: 0, objectEtag: "*", lock: { hold: true }, updatedAt: "" };
	return { sidecar: unreadable, etag: object.etag };
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
	const applies = stored && (stored.sidecar.objectEtag === "*" || stored.sidecar.objectEtag === object.etag);
	if (stored && applies) {
		const { lock, holdReleasedAt } = stored.sidecar;
		const state: LockState = {
			lock,
			...(object.uploaded ? { uploadedAt: object.uploaded } : {}),
			...(holdReleasedAt ? { holdReleasedAt: new Date(holdReleasedAt) } : {}),
		};
		return { state, source: "sidecar", stored };
	}
	const state = lockStateOf(object);
	return { state, source: state ? "upload" : "none", stored };
}

const VIDEO_STORAGE_KEY = /^(.*?)((?:public|private)\/video\/[^/]+\/.+)$/;

/** Splits a video object's storage key into its storage prefix and virtual key (`null` if it isn't one). */
export function splitVideoStorageKey(storageKey: string): { root: string; key: string } | null {
	const match = VIDEO_STORAGE_KEY.exec(storageKey);
	return match ? { root: match[1] ?? "", key: match[2] ?? "" } : null;
}
