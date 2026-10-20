// An object's encryption material in the keys bucket, swept when the object is deleted. Shared by the guarded delete
// routes (guard.ts) and the prefix delete a Worker's own code runs (prefix-delete.ts). Split into reading what to
// delete (`objectKeysToDelete`, `keysWrittenBy`) and deleting it (`deleteKeys`), so a bounded caller can check it
// can afford the writes before making any.
import { decodeEncryptionMeta } from "@devultur/core";
import { variantPrefix } from "../image/transform-plan";

/** R2 deletes up to 1000 keys per call. */
const DELETE_BATCH_SIZE = 1000;

async function listAll(bucket: R2Bucket, options: R2ListOptions): Promise<R2Object[]> {
	const objects: R2Object[] = [];
	let cursor: string | undefined;
	do {
		const listing = await bucket.list({ ...options, ...(cursor ? { cursor } : {}) });
		objects.push(...listing.objects);
		cursor = listing.truncated ? listing.cursor : undefined;
	} while (cursor);
	return objects;
}

/** The deleted object's version, read (HEAD) before its delete: its `enc` and when it was written. */
export type DeletedVersion = Pick<R2Object, "uploaded" | "customMetadata">;

/**
 * Whether a key belongs to the deleted version or one it replaced: written no later than `writtenBy`. A newer key is
 * an upload in flight (a multipart created over it, a PUT between its key and its put): shredding it would leave that
 * upload's object undecryptable.
 */
const isWrittenBy = (key: R2Object, writtenBy: Date) => key.uploaded.getTime() <= writtenBy.getTime();

/** Keys under `prefix` written no later than `writtenBy`. */
export async function keysWrittenBy(keysBucket: R2Bucket, prefix: string, writtenBy: Date): Promise<string[]> {
	return (await listAll(keysBucket, { prefix })).filter((key) => isWrittenBy(key, writtenBy)).map((key) => key.key);
}

/**
 * The encryption material of the object at `fullKey` (its storage key) that goes with it: its own keys (the direct
 * children of `{storageKey}/`; a key id has no `/`) no newer than the deleted version, and its variants'
 * (`{storageKey}/__variants/…`). Never a bare `{storageKey}/` prefix: an asset nested under this one's path
 * (`asset/a` and `asset/a/b.pdf` are both valid) keeps its keys at `{storageKey}/b.pdf/{keyId}`.
 */
export async function objectKeysToDelete(
	keysBucket: R2Bucket,
	fullKey: string,
	deleted: DeletedVersion,
): Promise<string[]> {
	const own = await listAll(keysBucket, { prefix: `${fullKey}/`, delimiter: "/" });
	const keys = new Set(own.filter((key) => isWrittenBy(key, deleted.uploaded)).map((key) => key.key));
	const meta = decodeEncryptionMeta(deleted.customMetadata?.enc);
	if (meta) keys.add(`${fullKey}/${meta.keyId}`);
	for (const variantKey of await listAll(keysBucket, { prefix: variantPrefix(fullKey) })) keys.add(variantKey.key);
	return [...keys];
}

/** Delete calls `deleteKeys` makes for `keys`. */
export const deleteCallsFor = (keys: string[]) => Math.ceil(keys.length / DELETE_BATCH_SIZE);

export async function deleteKeys(keysBucket: R2Bucket, keys: string[]): Promise<number> {
	for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
		await keysBucket.delete(keys.slice(start, start + DELETE_BATCH_SIZE));
	}
	return keys.length;
}

/** Deletes the object's encryption material (see `objectKeysToDelete`). Unguarded: check its lock first. */
export async function sweepObjectKeys(keysBucket: R2Bucket, fullKey: string, deleted: DeletedVersion): Promise<number> {
	return deleteKeys(keysBucket, await objectKeysToDelete(keysBucket, fullKey, deleted));
}
