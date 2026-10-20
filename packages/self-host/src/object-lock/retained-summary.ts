// "Can this prefix be deleted?": what under a storage prefix is retained, without deleting anything. Same walk,
// resolution and bounds as `deletePrefixRespectingLocks`, so a summary of a prefix and a delete of it agree on what
// stays.
import { lockResolver, toStoredObjectLock, UNRECOGNIZED_LOCK } from "./lock-status";
import {
	assertProgress,
	DEFAULT_MAX_SUBREQUESTS,
	decodeCursor,
	encodeCursor,
	type PrefixWalkOptions,
	subrequestBudget,
	type WalkedObject,
	walkPrefix,
} from "./prefix-walk";

export interface RetainedSummary {
	/** Objects looked at (lock records and audit not included). */
	scannedCount: number;
	/** What a delete would keep, keys not laid out like the Worker's included. */
	retainedCount: number;
	retainedBytes: number;
	/** The latest retention end among what's retained (ISO). Holds have none: see `hasHold`. */
	latestUntil?: string;
	/** Something retained is held (or has an unreadable lock record): it stays until released, not until a date. */
	hasHold: boolean;
	/** Set when the prefix isn't done: pass it back to go on. Combine the counts of every call. */
	cursor?: string;
	/** Bucket calls this call made. */
	subrequests: number;
}

/** What's retained under `options.prefix` (full storage keys). Bounded and resumable like the delete. */
export async function retainedSummary(options: PrefixWalkOptions): Promise<RetainedSummary> {
	const budget = subrequestBudget(options.maxSubrequests ?? DEFAULT_MAX_SUBREQUESTS);
	const mediaBucket = budget.track(options.mediaBucket);
	const resolveLock = lockResolver(mediaBucket, options.now ?? new Date());
	const summary: RetainedSummary = {
		scannedCount: 0,
		retainedCount: 0,
		retainedBytes: 0,
		hasHold: false,
		subrequests: 0,
	};

	const visit = async ({ listed, place }: WalkedObject) => {
		if (place.kind === "reserved") return;
		let lock = UNRECOGNIZED_LOCK;
		let size = listed.size;
		if (place.kind === "object") {
			const object = await mediaBucket.head(listed.key);
			if (!object) return;
			lock = toStoredObjectLock(await resolveLock(place, object), place);
			size = object.size;
		}
		summary.scannedCount += 1;
		if (!lock.locked) return;
		summary.retainedCount += 1;
		summary.retainedBytes += size;
		if (lock.hold) summary.hasHold = true;
		if (lock.until && (!summary.latestUntil || lock.until > summary.latestUntil)) summary.latestUntil = lock.until;
	};

	const walk = await walkPrefix(options, mediaBucket, decodeCursor(options.cursor), visit);
	assertProgress(walk.hasProgressed || walk.isDone);
	const cursor = walk.isDone ? undefined : encodeCursor(walk.position);
	return { ...summary, ...(cursor ? { cursor } : {}), subrequests: budget.used };
}
