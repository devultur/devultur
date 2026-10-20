// Deleting a whole storage prefix from a Worker's own code (an app's teardown, a sweeper for expired files) without
// destroying retained files. What it deletes, it deletes the way `DELETE /v1/media/…` does: the object, its encryption
// keys no newer than it (an upload in flight keeps its own) and its variants'; a video folder left empty also loses the
// rest of its keys written before the call started (the HLS key) and its transcode-completed marker. What's locked
// stays, with its keys, variants and lock record. Lock records of deleted objects stay too, inert: they're bound to
// the deleted versions. Lock records, audit objects and keys not laid out like the Worker's are never deleted.
//
// Each object is read first (its HEAD, its lock, the keys that go with it) and written only if the budget left covers
// every write, so a call never stops halfway through an object. A video folder that a call ends in, emptied of what
// it walked, travels in the cursor and is closed by the next call.
import {
	lockResolver,
	type ObjectPlace,
	type StoredObjectLock,
	toStoredObjectLock,
	UNRECOGNIZED_LOCK,
} from "./lock-status";
import { deleteCallsFor, deleteKeys, keysWrittenBy, objectKeysToDelete } from "./object-keys";
import {
	assertProgress,
	BudgetExhausted,
	DEFAULT_MAX_SUBREQUESTS,
	decodeCursor,
	encodeCursor,
	type PendingFolder,
	type PrefixWalkOptions,
	subrequestBudget,
	type WalkedObject,
	walkPrefix,
} from "./prefix-walk";
import { forgetTranscodeCompleted } from "./transcode-marker";

export interface PrefixDeleteOptions extends PrefixWalkOptions {
	/** The Worker's `KEYS_BUCKET`, when it has one: the encryption keys of what's deleted go too. */
	keysBucket?: R2Bucket;
}

/** An object kept because it's locked (or its original is, or its key isn't laid out like the Worker's). */
export interface RetainedObject extends StoredObjectLock {
	/** Its storage key. */
	key: string;
	size: number;
}

export interface PrefixDeleteResult {
	deletedCount: number;
	/** The sizes of the versions deleted, read right before each delete. */
	deletedBytes: number;
	/** Encryption keys deleted from the keys bucket. */
	deletedKeyCount: number;
	retainedCount: number;
	retainedBytes: number;
	/** What this call kept, in key order. */
	retained: RetainedObject[];
	/** Lock records and audit objects passed over (never deleted). */
	skippedCount: number;
	/** Set when the prefix isn't done: pass it back to go on. */
	cursor?: string;
	/** Bucket calls this call made. */
	subrequests: number;
}

const VIDEO_FOLDER = /^((?:public|private)\/video\/[^/]+)\//;

interface OpenFolder extends PendingFolder {
	hasDeleted: boolean;
	hasRetained: boolean;
}

const isPending = (folder: OpenFolder | null): folder is OpenFolder =>
	folder?.hasDeleted === true && !folder.hasRetained;

/**
 * Deletes what's free under `options.prefix` (full storage keys) and keeps what's locked. Bounded: it never makes more
 * than `maxSubrequests` bucket calls, and returns a `cursor` to call it again with. Nothing is audited: log `retained`
 * if you need a trail. R2 deletes aren't conditional: a lock set between an object's check and its delete isn't seen
 * (milliseconds for its own lock; for a lock it inherits, up to `LOCK_CACHE_MAX_AGE_MS`, as that lock is cached).
 */
export async function deletePrefixRespectingLocks(options: PrefixDeleteOptions): Promise<PrefixDeleteResult> {
	const startedAt = new Date();
	const budget = subrequestBudget(options.maxSubrequests ?? DEFAULT_MAX_SUBREQUESTS);
	const mediaBucket = budget.track(options.mediaBucket);
	const keysBucket = options.keysBucket ? budget.track(options.keysBucket) : undefined;
	const resolveLock = lockResolver(mediaBucket, options.now ?? startedAt);
	const start = decodeCursor(options.cursor);
	const result: PrefixDeleteResult = {
		deletedCount: 0,
		deletedBytes: 0,
		deletedKeyCount: 0,
		retainedCount: 0,
		retainedBytes: 0,
		retained: [],
		skippedCount: 0,
		subrequests: 0,
	};
	let openFolder: OpenFolder | null = start.folder ? { ...start.folder, hasDeleted: true, hasRetained: false } : null;
	let hasClosed = false;

	// A video folder this walk emptied: its remaining keys (the HLS key) and its marker go, as with a video delete.
	// Keys written after the call started belong to an upload in flight and stay. Safe to repeat if interrupted.
	const closeFolder = async () => {
		if (isPending(openFolder)) {
			const { root, folder } = openFolder;
			const folderPrefix = `${root}${folder}/`;
			const remaining = await mediaBucket.list({ prefix: folderPrefix, limit: 1 });
			if (remaining.objects.length === 0) {
				if (keysBucket) {
					const keys = await keysWrittenBy(keysBucket, folderPrefix, startedAt);
					result.deletedKeyCount += await deleteKeys(keysBucket, keys);
				}
				await forgetTranscodeCompleted(mediaBucket, root, folder);
			}
			hasClosed = true;
		}
		openFolder = null;
	};

	const enterFolder = async (place: ObjectPlace): Promise<OpenFolder | null> => {
		const folder = VIDEO_FOLDER.exec(place.key)?.[1];
		if (openFolder && openFolder.root === place.root && openFolder.folder === folder) return openFolder;
		await closeFolder();
		openFolder = folder ? { root: place.root, folder, hasDeleted: false, hasRetained: false } : null;
		return openFolder;
	};

	const retain = (key: string, size: number, lock: StoredObjectLock) => {
		result.retained.push({ key, size, ...lock });
		result.retainedCount += 1;
		result.retainedBytes += size;
	};

	const visit = async ({ listed, place }: WalkedObject) => {
		if (place.kind === "reserved") {
			result.skippedCount += 1;
			return;
		}
		if (place.kind === "unrecognized") return retain(listed.key, listed.size, UNRECOGNIZED_LOCK);
		const folder = await enterFolder(place);
		// The version deleted is the one checked: a replacement after the listing is checked, not trusted.
		const object = await mediaBucket.head(listed.key);
		if (!object) return;
		const locked = await resolveLock(place, object);
		if (locked) {
			if (folder) folder.hasRetained = true;
			return retain(listed.key, object.size, toStoredObjectLock(locked, place));
		}
		const keys = keysBucket ? await objectKeysToDelete(keysBucket, listed.key, object) : [];
		if (!budget.canAfford(1 + deleteCallsFor(keys))) throw new BudgetExhausted();
		await mediaBucket.delete(listed.key);
		result.deletedCount += 1;
		result.deletedBytes += object.size;
		if (folder) folder.hasDeleted = true;
		if (keysBucket) result.deletedKeyCount += await deleteKeys(keysBucket, keys);
	};

	const walk = await walkPrefix(options, mediaBucket, start, visit);
	if (walk.isDone) {
		try {
			await closeFolder();
		} catch (error) {
			if (!(error instanceof BudgetExhausted)) throw error;
		}
	}
	const pendingFolder = isPending(openFolder) ? { root: openFolder.root, folder: openFolder.folder } : undefined;
	const isFinished = walk.isDone && !pendingFolder;
	assertProgress(walk.hasProgressed || hasClosed || isFinished);
	const cursor = isFinished
		? undefined
		: encodeCursor({ ...walk.position, ...(pendingFolder ? { folder: pendingFolder } : {}) });
	return { ...result, ...(cursor ? { cursor } : {}), subrequests: budget.used };
}
