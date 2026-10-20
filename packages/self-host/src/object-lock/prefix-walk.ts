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

/** A cursor is bound to the prefix it was returned for: `{ prefix, after?, listCursor?, folder? }`, base64 JSON. */
export function encodeCursor(prefix: string, cursor: WalkCursor): string {
	return btoa(JSON.stringify({ prefix, ...cursor }));
}

const VIDEO_FOLDER_SHAPE = /^(?:public|private)\/video\/[^/]+$/;

function invalidCursor(reason: string): never {
	throw new RangeError(`cursor isn't one this function returned for this prefix: ${reason}`);
}

function parseCursor(cursor: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(atob(cursor));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
			return parsed as Record<string, unknown>;
	} catch {}
	return invalidCursor("not a cursor");
}

const isOptionalString = (value: unknown) => value === undefined || typeof value === "string";

/** A pending folder must be a video folder under `prefix`, at a storage prefix the walk itself would read. */
function validFolder(value: unknown, options: Pick<PrefixWalkOptions, "prefix" | "root">): PendingFolder | undefined {
	if (value === undefined) return undefined;
	const { root, folder } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
	if (typeof root !== "string" || typeof folder !== "string" || !VIDEO_FOLDER_SHAPE.test(folder)) {
		return invalidCursor("folder");
	}
	const folderPrefix = `${root}${folder}/`;
	const place = placeOfStorageKey(`${folderPrefix}x`, options.root);
	const isPlaced = place.kind === "object" && place.root === root;
	if (!isPlaced || !folderPrefix.startsWith(options.prefix)) return invalidCursor("folder outside the prefix");
	return { root, folder };
}

/** Reads a cursor this module returned for `options.prefix`; anything else throws `RangeError` before any call. */
export function decodeCursor(
	cursor: string | undefined,
	options: Pick<PrefixWalkOptions, "prefix" | "root">,
): WalkCursor {
	if (cursor === undefined) return {};
	const { prefix, after, listCursor, folder } = parseCursor(cursor);
	if (prefix !== options.prefix) return invalidCursor("another prefix");
	if (!isOptionalString(after) || !isOptionalString(listCursor)) return invalidCursor("position");
	if (typeof after === "string" && !after.startsWith(options.prefix))
		return invalidCursor("position outside the prefix");
	const pendingFolder = validFolder(folder, options);
	return {
		...(typeof after === "string" ? { after } : {}),
		...(typeof listCursor === "string" ? { listCursor } : {}),
		...(pendingFolder ? { folder: pendingFolder } : {}),
	};
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
		// The whole page is checked before any of it is visited: a key outside the prefix means a listing nobody asked for.
		const stray = listing.objects.find((listed) => !listed.key.startsWith(options.prefix));
		if (stray) throw new RangeError(`listing returned ${stray.key}, outside the prefix ${options.prefix}`);
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
