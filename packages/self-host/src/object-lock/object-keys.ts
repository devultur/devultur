// An object's encryption material in the keys bucket, swept when the object is deleted. Shared by the guarded delete
// routes (guard.ts) and the prefix delete a Worker's own code runs (prefix-delete.ts).
import { decodeEncryptionMeta } from "@devultur/core";
import { deletePrefix } from "../helpers";
import { variantPrefix } from "../image/transform-plan";

/**
 * The object's own keys in the keys bucket: the direct children of `{storageKey}/` (`{storageKey}/{keyId}`; a key id
 * has no `/`). The current `enc`'s and any a replaced version left behind. Never deeper: an asset nested under this
 * one's path (`asset/a` and `asset/a/b.pdf` are both valid) keeps its keys at `{storageKey}/b.pdf/{keyId}`.
 */
async function ownKeysOf(keysBucket: R2Bucket, fullKey: string): Promise<R2Object[]> {
	const keys: R2Object[] = [];
	let cursor: string | undefined;
	do {
		const listing = await keysBucket.list({ prefix: `${fullKey}/`, delimiter: "/", cursor });
		keys.push(...listing.objects);
		cursor = listing.truncated ? listing.cursor : undefined;
	} while (cursor);
	return keys;
}

/** The deleted object's version, read (HEAD) before its delete: its `enc` and when it was written. */
export type DeletedVersion = Pick<R2Object, "uploaded" | "customMetadata">;

/**
 * Whether a key under the object's prefix belongs to the deleted version or one it replaced: written no later than the
 * deleted object. A newer key is an upload in flight (a multipart created over it, a PUT between its key and its put):
 * shredding it would leave that upload's object undecryptable.
 */
function isKeyOfDeletedVersion(key: R2Object, deleted: DeletedVersion): boolean {
	return key.uploaded.getTime() <= deleted.uploaded.getTime();
}

/**
 * Deletes the encryption material of the object at `fullKey` (its storage key): its own keys (see `ownKeysOf`) no
 * newer than the deleted version, and its variants' (`{storageKey}/__variants/…`). Never a bare `{storageKey}/`
 * prefix: the keys of an asset nested under this one's path live there. Unguarded: check the object's lock first.
 * Returns how many keys it deleted.
 */
export async function sweepObjectKeys(keysBucket: R2Bucket, fullKey: string, deleted: DeletedVersion): Promise<number> {
	const ownKeys = new Set(
		(await ownKeysOf(keysBucket, fullKey)).filter((key) => isKeyOfDeletedVersion(key, deleted)).map((key) => key.key),
	);
	const meta = decodeEncryptionMeta(deleted.customMetadata?.enc);
	if (meta) ownKeys.add(`${fullKey}/${meta.keyId}`);
	if (ownKeys.size > 0) await keysBucket.delete([...ownKeys]);
	return ownKeys.size + (await deletePrefix(keysBucket, variantPrefix(fullKey)));
}
