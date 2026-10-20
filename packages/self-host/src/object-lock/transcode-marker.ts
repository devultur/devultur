// Durable "this video's transcode completed" marker, at `{storagePrefix}__lock/{visibility}/video/{id}/
// transcode-completed` (the reserved prefix, so no route can forge or delete it). The 24 h status record can't tell
// "never completed" from "completed long ago"; this can, which is what `assertRetranscodable` needs: a video that
// never finished a transcode may retry (its partial outputs were never a finished set), one that did may not.

import type { JobLocation } from "../transcode/job-ticket";
import { readRawDisposal } from "../transcode/raw-retention";
import type { WorkerEnv } from "../types";
import { sidecarKey, splitVideoStorageKey } from "./sidecar";

const MARKER_NAME = "transcode-completed";

const markerKey = (root: string, videoFolder: string) => sidecarKey(root, `${videoFolder}/${MARKER_NAME}`);

/**
 * On an authenticated `transcode.complete`: marks the video's folder. The location comes from the job's signed ticket,
 * which lives as long as the job's callbacks; a runner that sends no ticket falls back to what the launch remembered in
 * KV (24 h).
 */
export async function markTranscodeCompleted(
	env: WorkerEnv,
	videoId: string,
	ticketLocation: JobLocation | null,
): Promise<void> {
	const location = ticketLocation ?? (await rememberedLocation(env, videoId));
	if (!location) return;
	await env.MEDIA_BUCKET.put(markerKey(location.root, location.folder), new Date().toISOString(), {
		httpMetadata: { contentType: "text/plain" },
	});
}

async function rememberedLocation(env: WorkerEnv, videoId: string): Promise<JobLocation | null> {
	const disposal = await readRawDisposal(env.MEDIA_KV, videoId);
	const raw = disposal?.storageKey ? splitVideoStorageKey(disposal.storageKey) : null;
	const folder = raw?.key.split("/").slice(0, 3).join("/");
	return raw && folder ? { root: raw.root, folder } : null;
}

/** True once a transcode of the video in `videoFolder` (virtual, `{visibility}/video/{id}`) completed. */
export async function hasCompletedTranscode(bucket: R2Bucket, root: string, videoFolder: string): Promise<boolean> {
	return (await bucket.head(markerKey(root, videoFolder))) !== null;
}

/** Deletes the marker of `videoFolder`: its video was deleted (with every output the marker vouched for). */
export async function forgetTranscodeCompleted(bucket: R2Bucket, root: string, videoFolder: string): Promise<void> {
	await bucket.delete(markerKey(root, videoFolder));
}
