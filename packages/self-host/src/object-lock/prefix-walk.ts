// A bounded, resumable walk over a storage prefix, shared by `deletePrefixRespectingLocks` and `retainedSummary`.
// A Worker invocation has a subrequest limit, and every bucket call counts. Each call goes through a budget that
// refuses (throws `BudgetExhausted`) the call that would go past `maxSubrequests`; an object a refusal interrupts is
// left as it was and is the first one the next call looks at. The cursor says where to go on from.
import { type KeyPlace, type LockLookupOptions, placeOfStorageKey } from "./lock-status";

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

/** Thrown by a tracked bucket instead of making a call past the budget. */
export class BudgetExhausted extends Error {
	constructor() {
		super("subrequest budget exhausted");
	}
}

export interface SubrequestBudget {
	readonly used: number;
	canAfford: (count: number) => boolean;
	/** `bucket` with every call counted, and refused once the budget is spent. */
	track: (bucket: R2Bucket) => R2Bucket;
}

export function subrequestBudget(max: number): SubrequestBudget {
	if (!Number.isInteger(max) || max < 1) throw new RangeError("maxSubrequests must be a positive integer");
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
						if (used >= max) throw new BudgetExhausted();
						used += 1;
						return value.apply(target, args);
					};
				},
			}),
	};
}

/** Where a walk stands: after a key, or at an R2 cursor (an empty page R2 marked truncated). */
export interface WalkPosition {
	after?: string;
	listCursor?: string;
}

/** A video folder a delete emptied of everything it walked, still to be closed (see prefix-delete.ts). */
export interface PendingFolder {
	root: string;
	folder: string;
}

export interface WalkCursor extends WalkPosition {
	folder?: PendingFolder;
}

export function encodeCursor(cursor: WalkCursor): string {
	return btoa(JSON.stringify(cursor));
}

export function decodeCursor(cursor: string | undefined): WalkCursor {
	if (cursor === undefined) return {};
	try {
		const decoded = JSON.parse(atob(cursor)) as WalkCursor;
		if (typeof decoded === "object" && decoded !== null) return decoded;
	} catch {}
	throw new RangeError("cursor isn't one this function returned");
}

export interface WalkedObject {
	listed: R2Object;
	place: KeyPlace;
}

export interface WalkOutcome {
	position: WalkPosition;
	isDone: boolean;
	/** Anything got done: an object finished, or the listing moved on. */
	hasProgressed: boolean;
}

/**
 * Walks `options.prefix` from `start` with `mediaBucket` (tracked by the budget), calling `visit` per object in key
 * order. `visit` may throw `BudgetExhausted` only before it changes anything.
 */
export async function walkPrefix(
	options: PrefixWalkOptions,
	mediaBucket: R2Bucket,
	start: WalkPosition,
	visit: (object: WalkedObject) => Promise<void>,
): Promise<WalkOutcome> {
	const limit = Math.min(Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE)), MAX_BATCH_SIZE);
	let position: WalkPosition = { ...start };
	let hasProgressed = false;
	const stopped = () => ({ position, isDone: false, hasProgressed });
	for (;;) {
		let listing: R2Objects;
		try {
			listing = await mediaBucket.list({ prefix: options.prefix, limit, ...listFrom(position) });
		} catch (error) {
			if (error instanceof BudgetExhausted) return stopped();
			throw error;
		}
		for (const listed of listing.objects) {
			try {
				await visit({ listed, place: placeOfStorageKey(listed.key, options.root) });
			} catch (error) {
				if (error instanceof BudgetExhausted) return stopped();
				throw error;
			}
			position = { after: listed.key };
			hasProgressed = true;
		}
		if (!listing.truncated) return { position, isDone: true, hasProgressed };
		if (listing.objects.length > 0) continue;
		position = { ...position, listCursor: listing.cursor };
		hasProgressed = true;
	}
}

function listFrom(position: WalkPosition): Pick<R2ListOptions, "cursor" | "startAfter"> {
	if (position.listCursor) return { cursor: position.listCursor };
	return position.after ? { startAfter: position.after } : {};
}

/** A call that couldn't finish a single thing would hand back the same cursor forever. */
export function assertProgress(hasProgressed: boolean): void {
	if (hasProgressed) return;
	throw new RangeError("maxSubrequests is too small to finish the next object: raise it");
}
