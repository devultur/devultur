// Deletes of media, behind the lock guard: a locked object (or a video with a locked raw) loses nothing, and the
// encryption keys of what's deleted go through the same check (deleting them destroys the object too).
import { videoBasePath } from "@devultur/core";
import type { Context } from "hono";
import { storageKey } from "../helpers";
import { isVariantKey, variantPrefix } from "../image/transform-plan";
import {
	assertWritable,
	deleteFolderKeys,
	deleteKeysFor,
	guardedDeletePrefix,
	isReservedLockKey,
	reservedKeyResponse,
} from "../object-lock/guard";
import { forgetLock } from "../object-lock/sidecar";
import { getRequestState } from "../request-state";
import type { WorkerApp } from "../types";

export async function handleVideoDelete(context: Context<WorkerApp>): Promise<Response> {
	const videoId = context.req.param("videoId") ?? "";
	// All of a video's objects live under `{visibility}/video/{id}/` (raw, hls, mp4, thumbnails,
	// storyboard, captions) — see the path helpers in @devultur/core. The prefix MUST include the `video/`
	// segment; without it the list matches nothing and the delete becomes a silent no-op (a
	// privacy regression + an R2 leak). The reference carries the visibility; if it's missing, we sweep both.
	const visibilityParam = context.req.query("visibility");
	const visibilities =
		visibilityParam === "public" || visibilityParam === "private" ? [visibilityParam] : ["public", "private"];

	// Idempotent: with no objects under the prefix (already deleted, or a retry after a lost response),
	// returns 200 with deletedCount 0. Anyone keeping an inventory can reconcile it on any 2xx from the
	// delete → there's no desync from a retry or from objects already gone; a 5xx (a real failure) means
	// nothing was deleted. R2 deletes in batches (up to 1000 keys/call), not one call per object.
	// A video's L4 keys (raw/thumbnail/captions at `${objectKey}/{keyId}`, HLS at `hls/{keyId}`) hang off
	// the SAME prefix in KEYS_BUCKET → they're swept together with the media; otherwise they'd be orphaned forever.
	// A thumbnail's variants (`{thumbKey}/__variants/…`) and their keys also fall under this prefix.
	// Locks first, for every visibility: a video with a retained raw (or a held one) loses nothing.
	const folders = visibilities.map((visibility) => `${visibility}/${videoBasePath(videoId)}`);
	const blocked = await assertWritable(context, folders, "delete");
	if (blocked) return blocked;

	let deletedCount = 0;
	let deletedKeyCount = 0;
	for (const folder of folders) {
		const deleted = await guardedDeletePrefix(context, `${folder}/`);
		if ("blocked" in deleted) return deleted.blocked;
		deletedCount += deleted.deletedCount;
		// L4: a private object's encryption material (HLS key at `hls/{keyId}`, at-rest keys for the raw, MP4, poster,
		// storyboard… at `{object}/{keyId}`) lives under the SAME prefix in the keys bucket. Public never encrypts
		// (shouldEncryptAtRest), so there's nothing to sweep there.
		if (!folder.startsWith("private/")) continue;
		const deletedKeys = await deleteFolderKeys(context, folder);
		if ("blocked" in deletedKeys) return deletedKeys.blocked;
		deletedKeyCount += deletedKeys.deletedCount;
	}

	return context.json({ videoId, deletedCount, deletedKeyCount });
}

export async function handleKeyDelete(context: Context<WorkerApp>): Promise<Response> {
	const key = context.req.param("key") ?? "";
	const fullKey = storageKey(context, key);
	// Derived objects get deleted along with their original, never on their own (they'd just regenerate on the next request).
	if (isVariantKey(key)) {
		return context.json({ error: "Not found" }, 404);
	}
	if (isReservedLockKey(key)) return reservedKeyResponse(context, key);

	const exists = await context.env.MEDIA_BUCKET.head(fullKey);
	if (!exists) {
		return context.json({ error: "Not found" }, 404);
	}
	const blocked = await assertWritable(context, [key], "delete");
	if (blocked) return blocked;

	await context.env.MEDIA_BUCKET.delete(fullKey);
	// Variants and the mezzanine live under `{key}/__variants/`. Always swept (even with the kill switch on
	// `cloudflare`, some may be left over from before). In MEDIA_BUCKET, only that sub-prefix: a bare `{key}/`
	// could touch another object whose name starts the same way.
	const variants = await guardedDeletePrefix(context, variantPrefix(key));
	if ("blocked" in variants) return variants.blocked;
	// Its own L4 key (`${fullKey}/{keyId}`) and its variants' keys: not the keys of an asset nested under its path.
	const keys = await deleteKeysFor(context, key, exists.customMetadata?.enc);
	if ("blocked" in keys) return keys.blocked;
	// Its lock record goes with it: a file uploaded later at this key starts from its own upload lock.
	await forgetLock(context.env.MEDIA_BUCKET, getRequestState(context).storagePrefix, key);
	return new Response(null, { status: 204 });
}
