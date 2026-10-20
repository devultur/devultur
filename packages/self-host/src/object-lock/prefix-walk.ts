// A bounded, resumable walk over a storage prefix, shared by `deletePrefixRespectingLocks` and `retainedSummary`.
// A Worker invocation has a subrequest limit, and every bucket call counts: the walk counts its own and stops before
// the next object could take it past `maxSubrequests`, handing back a cursor (the last key it finished) to resume
// from. Keys under the reserved lock prefixes are passed over: the lock records and audit stay.
import { isReservedLockKey } from "./guard";
import { type LockLookupOptions, type SplitKey, splitStorageKey } from "./lock-status";

export interface PrefixWalkOptions extends LockLookupOptions {
	/** Storage prefix to walk (full R2 keys, the storage prefix of the keys included). */
	prefix: string;
	/** From a previous call's result, to go on where it stopped. */
	cursor?: string;
	/** Objects listed per page. Default 100, at most 1000. */
	batchSize?: number;
	/**
	 * Bucket calls this call may make. Default 40: under the free plan's 50 subrequests per request, with room for the
	 * caller's own. Raise it on a paid plan.
	 */
	maxSubrequests?: number;
}

export const DEFAULT_MAX_SUBREQUESTS = 40;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1000;

export interface SubrequestBudget {
	readonly used: number;
	canAfford: (count: number) => boolean;
	/** `bucket` with every call counted against the budget. */
	track: (bucket: R2Bucket) => R2Bucket;
}

export function subrequestBudget(max: number): SubrequestBudget {
	let used = 0;
	return {
		get used() {
			return used;
		},
		canAfford: (count) => used + count <= max,
		track: (bucket) =>
			new Proxy(bucket, {
				get(target, property) {
					const value = Reflect.get(target, property);
					if (typeof value !== "function") return value;
					return (...args: unknown[]) => {
						used += 1;
						return value.apply(target, args);
					};
				},
			}),
	};
}

export interface WalkedObject {
	listed: R2Object;
	split: SplitKey;
}

export interface WalkPlan {
	budget: SubrequestBudget;
	/** Most bucket calls one object can take, everything it triggers included. */
	objectCost: number;
	visit: (object: WalkedObject) => Promise<void>;
}

/** The minimum `maxSubrequests` a walk needs to make progress: one listing and one object. */
export const minimumSubrequests = (objectCost: number) => 1 + objectCost;

/** Walks `options.prefix` until it's done (`{}`) or the budget runs short (`{ cursor }`). */
export async function walkPrefix(
	options: PrefixWalkOptions,
	mediaBucket: R2Bucket,
	plan: WalkPlan,
): Promise<{ cursor?: string }> {
	const limit = Math.min(Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE)), MAX_BATCH_SIZE);
	let lastKey = options.cursor;
	while (plan.budget.canAfford(minimumSubrequests(plan.objectCost))) {
		const listing = await mediaBucket.list({
			prefix: options.prefix,
			limit,
			...(lastKey ? { startAfter: lastKey } : {}),
		});
		for (const listed of listing.objects) {
			if (!plan.budget.canAfford(plan.objectCost)) return { cursor: lastKey ?? "" };
			const split = splitStorageKey(listed.key, options.root);
			if (split && !isReservedLockKey(split.key)) await plan.visit({ listed, split });
			lastKey = listed.key;
		}
		if (!listing.truncated) return {};
	}
	return { cursor: lastKey ?? "" };
}

export function assertBudget(maxSubrequests: number, objectCost: number): void {
	const minimum = minimumSubrequests(objectCost);
	if (maxSubrequests >= minimum) return;
	throw new RangeError(`maxSubrequests must be at least ${minimum}`);
}
