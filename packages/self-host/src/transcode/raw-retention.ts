// Retention of the original (raw) after transcode. On launch, what to do with the raw is remembered per videoId (the
// runner's webhook arrives without the request's config); on receiving `transcode.complete` it's deleted if that
// was requested. A `transcode.failed` never touches it: without the raw there's no possible retry.
import { isVideoRawKey } from "@devultur/core";
import type { Context } from "hono";
import { deletePrefix, KV_JOB_TTL_SECONDS, KvPrefix } from "../helpers";
import { type EmitOptions, emitMediaChanged } from "../media-events/emit";
import { mediaOfKey } from "../media-events/media-key";
import { recordLockAudit } from "../object-lock/audit";
import { effectiveLock, splitVideoStorageKey } from "../object-lock/sidecar";
import { isStateLocked } from "../object-lock/state";
import type { WorkerApp } from "../types";

interface RawDisposal {
	/** Full R2 key of the raw (with the storage prefix). */
	storageKey: string;
	deleteOnComplete: boolean;
}

const disposalKey = (videoId: string) => `${KvPrefix.TRANSCODE_RAW}:${videoId}`;

/** What the launch remembered for `videoId` (24 h): the raw's storage key and whether to delete it. */
export async function readRawDisposal(kv: KVNamespace, videoId: string): Promise<RawDisposal | null> {
	return kv.get<RawDisposal>(disposalKey(videoId), "json");
}

/** On accepting the transcode. A re-transcode replaces the previous decision (the one from the current setting). */
export async function rememberRawDisposal(kv: KVNamespace, videoId: string, disposal: RawDisposal): Promise<void> {
	await kv.put(disposalKey(videoId), JSON.stringify(disposal), { expirationTtl: KV_JOB_TTL_SECONDS });
}

/** What `transcode.complete` did with the raw: deleted it, kept it because it's locked, or wasn't asked to. */
export type RawDisposalOutcome = "deleted" | "retained" | "kept";

/**
 * After an authenticated `transcode.complete`: deletes the raw (and its L4 key at `${storageKey}/{keyId}` in the
 * keys bucket) if requested. A locked raw wins over `deleteOriginalOnSuccess` (decision 6 of #3): it stays, the skip
 * is logged and the webhook still succeeds. Idempotent: a retried webhook deletes nothing again and returns `deleted`.
 * Deleting it is a `media.changed` with `original-deleted`, sent to `events.target` (the launching scope's webhook).
 */
export async function disposeRawAfterTranscode(
	context: Context<WorkerApp>,
	videoId: string,
	events: EmitOptions = {},
): Promise<RawDisposalOutcome> {
	const { env } = context;
	const disposal = await readRawDisposal(env.MEDIA_KV, videoId);
	if (!disposal?.deleteOnComplete || !disposal.storageKey) return "kept";

	const raw = await env.MEDIA_BUCKET.head(disposal.storageKey);
	const location = splitVideoStorageKey(disposal.storageKey);
	const lock = raw && location ? await effectiveLock(env.MEDIA_BUCKET, location.root, location.key, raw) : null;
	if (lock?.state && isStateLocked(lock.state, new Date())) {
		await recordLockAudit(context, {
			action: "original_retained",
			keys: [location?.key ?? disposal.storageKey],
			before: lock.state.lock,
			after: null,
			outcome: "skipped",
			root: location?.root ?? "",
		});
		return "retained";
	}

	await env.MEDIA_BUCKET.delete(disposal.storageKey);
	if (env.KEYS_BUCKET) await deletePrefix(env.KEYS_BUCKET, `${disposal.storageKey}/`);
	const media = location ? mediaOfKey(location.key) : null;
	if (raw && location && media) {
		const data = { key: location.key, mediaId: media.mediaId, etag: raw.etag };
		await emitMediaChanged(context, { ...data, changes: ["original-deleted"] }, events);
	}
	return "deleted";
}

/** Re-encoding requires the raw: if it's gone but the video did transcode, the 410 says so (not a silent 404). */
export const ORIGINAL_NOT_RETAINED = {
	error:
		"The original of this video is no longer retained, so it can't be re-encoded. Upload it again, or set `config.transcode.deleteOriginalOnSuccess` to false for future videos.",
	code: "original_not_retained",
} as const;

/** How many keys of the video's folder are checked: the raw is gone, so any output shows up among the first ones. */
const PRIOR_OUTPUTS_LIST_LIMIT = 100;

/**
 * Did any output from a previous transcode remain in the video's folder (`{storagePrefix}{visibility}/video/{id}/`)?
 * Any key outside `raw/` counts: HLS playlist, MP4 renditions (from a preset without HLS), poster, thumbnail,
 * storyboard. The video record's `renditions` are keys in that same folder, so they're covered too.
 */
export async function hasPriorTranscodeOutputs(bucket: R2Bucket, videoFolder: string): Promise<boolean> {
	const listing = await bucket.list({ prefix: videoFolder, limit: PRIOR_OUTPUTS_LIST_LIMIT });
	return listing.objects.some((object) => !isVideoRawKey(object.key));
}
