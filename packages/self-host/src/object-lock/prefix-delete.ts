// Deleting a whole storage prefix from a Worker's own code (an app's teardown, a sweeper for expired files) without
// destroying retained files. What it deletes, it deletes the way `DELETE /v1/media/…` does: the object, its encryption
// keys no newer than it (an upload in flight keeps its own) and its variants'; a video folder left empty also loses the
// rest of its keys (the HLS key) and its transcode-completed marker. What's locked stays, with its keys, variants and
// lock record. Lock records of deleted objects stay too, inert: they're bound to the deleted versions.

import { deletePrefix } from "../helpers";
import { lockResolver, type StoredObjectLock, toStoredObjectLock } from "./lock-status";
import { sweepObjectKeys } from "./object-keys";
import {
	assertBudget,
	DEFAULT_MAX_SUBREQUESTS,
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

/** An object kept because it's locked (or its original is). */
export interface RetainedObject extends StoredObjectLock {
	/** Its storage key. */
	key: string;
	size: number;
}

export interface PrefixDeleteResult {
	deletedCount: number;
	deletedBytes: number;
	/** Encryption keys deleted from the keys bucket. */
	deletedKeyCount: number;
	retainedCount: number;
	retainedBytes: number;
	/** What this call kept, in key order. */
	retained: RetainedObject[];
	/** Set when the prefix isn't done: pass it back to go on. */
	cursor?: string;
	/** Bucket calls this call made. */
	subrequests: number;
}

// Bucket calls per object, at most: its lock (an original's head and sidecar, or a video's raw listing and one raw's
// head and sidecar), its delete, its keys (own keys listed and deleted, variant keys listed and deleted), and closing
// two video folders (listing the folder, its keys listed and deleted, the marker deleted).
const LOCK_COST = 4;
const DELETE_COST = 5;
const FOLDER_COST = 4;
const OBJECT_COST = LOCK_COST + DELETE_COST + 2 * FOLDER_COST;

const VIDEO_FOLDER = /^((?:public|private)\/video\/[^/]+)\//;

interface OpenFolder {
	root: string;
	folder: string;
	hasDeleted: boolean;
	hasRetained: boolean;
}

/**
 * Deletes what's free under `options.prefix` (full storage keys) and keeps what's locked. Bounded: it stops before
 * `maxSubrequests` bucket calls and returns a `cursor` to call it again with. Nothing is audited: log `retained` if you
 * need a trail. R2 deletes aren't conditional, so a lock set between the check and the delete (milliseconds) isn't seen.
 */
export async function deletePrefixRespectingLocks(options: PrefixDeleteOptions): Promise<PrefixDeleteResult> {
	const maxSubrequests = options.maxSubrequests ?? DEFAULT_MAX_SUBREQUESTS;
	assertBudget(maxSubrequests, OBJECT_COST);
	const budget = subrequestBudget(maxSubrequests);
	const mediaBucket = budget.track(options.mediaBucket);
	const keysBucket = options.keysBucket ? budget.track(options.keysBucket) : undefined;
	const resolveLock = lockResolver(mediaBucket, options.now ?? new Date());
	const result: PrefixDeleteResult = {
		deletedCount: 0,
		deletedBytes: 0,
		deletedKeyCount: 0,
		retainedCount: 0,
		retainedBytes: 0,
		retained: [],
		subrequests: 0,
	};
	let openFolder: OpenFolder | null = null;

	// A video folder this walk emptied: its remaining keys (the HLS key) and its marker go, as with a video delete.
	const closeFolder = async () => {
		const closing = openFolder;
		openFolder = null;
		if (!closing?.hasDeleted || closing.hasRetained) return;
		const folderPrefix = `${closing.root}${closing.folder}/`;
		const remaining = await mediaBucket.list({ prefix: folderPrefix, limit: 1 });
		if (remaining.objects.length > 0) return;
		if (keysBucket) result.deletedKeyCount += await deletePrefix(keysBucket, folderPrefix);
		await forgetTranscodeCompleted(mediaBucket, closing.root, closing.folder);
	};

	const enterFolder = async ({ split }: WalkedObject): Promise<OpenFolder | null> => {
		const folder = VIDEO_FOLDER.exec(split.key)?.[1];
		if (openFolder && openFolder.root === split.root && openFolder.folder === folder) return openFolder;
		await closeFolder();
		openFolder = folder ? { root: split.root, folder, hasDeleted: false, hasRetained: false } : null;
		return openFolder;
	};

	const visit = async (object: WalkedObject) => {
		const { listed, split } = object;
		const folder = await enterFolder(object);
		const locked = await resolveLock(split);
		if (locked) {
			if (folder) folder.hasRetained = true;
			result.retained.push({ key: listed.key, size: listed.size, ...toStoredObjectLock(locked, split) });
			result.retainedCount += 1;
			result.retainedBytes += listed.size;
			return;
		}
		await mediaBucket.delete(listed.key);
		result.deletedCount += 1;
		result.deletedBytes += listed.size;
		if (folder) folder.hasDeleted = true;
		if (keysBucket) result.deletedKeyCount += await sweepObjectKeys(keysBucket, listed.key, listed);
	};

	const { cursor } = await walkPrefix(options, mediaBucket, { budget, objectCost: OBJECT_COST, visit });
	await closeFolder();
	return { ...result, ...(cursor !== undefined ? { cursor } : {}), subrequests: budget.used };
}
