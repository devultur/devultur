// Lock headers on a trusted (owner) read, so the backend sees an object's retention without a second call.
// Never on viewer reads: a lock is the owner's business.
import { effectiveUntil } from "@devultur/core";
import type { Context } from "hono";
import { getRequestState } from "../request-state";
import { expiredResponse, isObjectExpired } from "../routes/object-response";
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

/** What retains a locked object: its effective expiry (when known) and its hold. */
export interface Retained {
	until?: string;
	hold: boolean;
}

/** `object` (virtual `key` under `root`)'s retention while it's locked, or `null` when it's free. */
export async function retainedOf(
	bucket: R2Bucket,
	location: { root: string; key: string },
	object: LockedObject,
): Promise<Retained | null> {
	const { state } = await effectiveLock(bucket, location.root, location.key, object);
	if (!state || !isStateLocked(state, new Date())) return null;
	let until: string | undefined;
	try {
		until = effectiveUntil(state.lock, timingOf(state));
	} catch {}
	return { ...(until ? { until } : {}), hold: state.lock.hold === true };
}

/**
 * The `410` for a read past the object's `expiresAt`, or `null` to serve it. Retention preserves; it doesn't extend
 * access: viewers and public requests get `410` once a file expires, retained or not. Only the owner (a trusted read
 * with the server credential) still reads a retained one, to export or audit it. A free expired file is gone for
 * everyone, waiting for the expiry cleanup.
 */
export async function expiredRefusal(
	bucket: R2Bucket,
	location: { root: string; key: string },
	object: LockedObject,
	isOwnerRead: boolean,
): Promise<Response | null> {
	if (!isObjectExpired(object.customMetadata)) return null;
	if (isOwnerRead && (await retainedOf(bucket, location, object)) !== null) return null;
	return expiredResponse();
}
