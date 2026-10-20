// Retention of the original (raw) after transcode. On launch, what to do with the raw is remembered per videoId (the
// runner's webhook arrives without the request's config); on receiving `transcode.complete` it's deleted if that
// was requested. A `transcode.failed` never touches it: without the raw there's no possible retry.
import { isVideoRawKey } from "@devultur/core";
import { deletePrefix, KV_JOB_TTL_SECONDS, KvPrefix } from "../helpers";
import { recordLockAudit } from "../object-lock/audit";
import { isStateLocked, readLockState } from "../object-lock/state";
import type { WorkerEnv } from "../types";

interface RawDisposal {
	/** Full R2 key of the raw (with the storage prefix). */
	storageKey: string;
	deleteOnComplete: boolean;
}

const disposalKey = (videoId: string) => `${KvPrefix.TRANSCODE_RAW}:${videoId}`;

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
 */
export async function disposeRawAfterTranscode(env: WorkerEnv, videoId: string): Promise<RawDisposalOutcome> {
	const disposal = await env.MEDIA_KV.get<RawDisposal>(disposalKey(videoId), "json");
	if (!disposal?.deleteOnComplete || !disposal.storageKey) return "kept";

	const lockState = await readLockState(env.MEDIA_BUCKET, disposal.storageKey);
	if (lockState && isStateLocked(lockState, new Date())) {
		console.log(JSON.stringify({ event: "lock.original_retained", videoId, key: disposal.storageKey }));
		await recordLockAudit({ type: "original_retained", key: disposal.storageKey, videoId });
		return "retained";
	}

	await env.MEDIA_BUCKET.delete(disposal.storageKey);
	if (env.KEYS_BUCKET) await deletePrefix(env.KEYS_BUCKET, `${disposal.storageKey}/`);
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
