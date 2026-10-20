// "Can this prefix be deleted?": what under a storage prefix is retained, without deleting anything. Same walk and
// bounds as `deletePrefixRespectingLocks`, so a summary of a prefix and a delete of it agree on what stays.
import { lockResolver, toStoredObjectLock } from "./lock-status";
import {
	assertBudget,
	DEFAULT_MAX_SUBREQUESTS,
	type PrefixWalkOptions,
	subrequestBudget,
	type WalkedObject,
	walkPrefix,
} from "./prefix-walk";

export interface RetainedSummary {
	/** Objects looked at (lock records and audit not included). */
	scannedCount: number;
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

/** An original's head and sidecar, or a video's raw listing and one raw's head and sidecar. */
const OBJECT_COST = 4;

/** What's retained under `options.prefix` (full storage keys). Bounded and resumable like the delete. */
export async function retainedSummary(options: PrefixWalkOptions): Promise<RetainedSummary> {
	const maxSubrequests = options.maxSubrequests ?? DEFAULT_MAX_SUBREQUESTS;
	assertBudget(maxSubrequests, OBJECT_COST);
	const budget = subrequestBudget(maxSubrequests);
	const mediaBucket = budget.track(options.mediaBucket);
	const resolveLock = lockResolver(mediaBucket, options.now ?? new Date());
	const summary: RetainedSummary = {
		scannedCount: 0,
		retainedCount: 0,
		retainedBytes: 0,
		hasHold: false,
		subrequests: 0,
	};

	const visit = async ({ listed, split }: WalkedObject) => {
		summary.scannedCount += 1;
		const locked = await resolveLock(split);
		if (!locked) return;
		const lock = toStoredObjectLock(locked, split);
		summary.retainedCount += 1;
		summary.retainedBytes += listed.size;
		if (lock.hold) summary.hasHold = true;
		if (lock.until && (!summary.latestUntil || lock.until > summary.latestUntil)) summary.latestUntil = lock.until;
	};

	const { cursor } = await walkPrefix(options, mediaBucket, { budget, objectCost: OBJECT_COST, visit });
	return { ...summary, ...(cursor !== undefined ? { cursor } : {}), subrequests: budget.used };
}
