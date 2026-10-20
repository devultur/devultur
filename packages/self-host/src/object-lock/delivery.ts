// Lock headers on a trusted (owner) read, so the backend sees an object's retention without a second call.
// Never on viewer reads: a lock is the owner's business.
import { effectiveUntil } from "@devultur/core";
import type { Context } from "hono";
import { getRequestState } from "../request-state";
import { isObjectExpired } from "../routes/object-response";
import type { WorkerApp } from "../types";
import { timingOf } from "./change";
import { effectiveLock } from "./sidecar";
import { isStateLocked } from "./state";

/** Retention expiry (ISO) of a locked object. */
export const LOCK_UNTIL_HEADER = "x-devultur-lock-until";
/** `true` while a hold is set. */
export const LOCK_HOLD_HEADER = "x-devultur-lock-hold";

type LockedObject = Pick<R2Object, "customMetadata" | "etag"> & { uploaded?: Date };

/** Headers for `object` (virtual `key`), empty when it isn't locked. */
export async function lockHeaders(
	context: Context<WorkerApp>,
	key: string,
	object: LockedObject,
): Promise<[string, string][]> {
	const root = getRequestState(context).storagePrefix;
	const { state } = await effectiveLock(context.env.MEDIA_BUCKET, root, key, object);
	if (!state || !isStateLocked(state, new Date())) return [];
	const headers: [string, string][] = [];
	try {
		const until = effectiveUntil(state.lock, timingOf(state));
		if (until) headers.push([LOCK_UNTIL_HEADER, until]);
	} catch {}
	if (state.lock.hold) headers.push([LOCK_HOLD_HEADER, "true"]);
	return headers;
}

/**
 * True when `object` is past its `expiresAt` and nothing holds it. A locked file doesn't expire: it's served (not
 * `410`) until its lock ends, so a hold or retention set after upload keeps the file readable as well as undeletable.
 */
export async function isExpiredAndUnlocked(
	bucket: R2Bucket,
	location: { root: string; key: string },
	object: LockedObject,
): Promise<boolean> {
	if (!isObjectExpired(object.customMetadata)) return false;
	const { state } = await effectiveLock(bucket, location.root, location.key, object);
	return !state || !isStateLocked(state, new Date());
}
