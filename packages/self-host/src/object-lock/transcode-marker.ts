// Durable "this video's transcode completed" marker, at `{storagePrefix}__lock/{visibility}/video/{id}/
// transcode-completed` (the reserved prefix, so no route can forge or delete it). The 24 h status record can't tell
// "never completed" from "completed long ago"; this can, which is what `assertRetranscodable` needs: a video that
// never finished a transcode may retry (its partial outputs were never a finished set), one that did may not.

import { readRawDisposal } from "../transcode/raw-retention";
import type { WorkerEnv } from "../types";
import { sidecarKey, splitVideoStorageKey } from "./sidecar";

const MARKER_NAME = "transcode-completed";

const markerKey = (root: string, videoFolder: string) => sidecarKey(root, `${videoFolder}/${MARKER_NAME}`);

/** On an authenticated `transcode.complete`: finds the video's folder from what the launch remembered and marks it. */
export async function markTranscodeCompleted(env: WorkerEnv, videoId: string): Promise<void> {
	const disposal = await readRawDisposal(env.MEDIA_KV, videoId);
	const location = disposal?.storageKey ? splitVideoStorageKey(disposal.storageKey) : null;
	const videoFolder = location?.key.split("/").slice(0, 3).join("/");
	if (!location || !videoFolder) return;
	await env.MEDIA_BUCKET.put(markerKey(location.root, videoFolder), new Date().toISOString(), {
		httpMetadata: { contentType: "text/plain" },
	});
}

/** True once a transcode of the video in `videoFolder` (virtual, `{visibility}/video/{id}`) completed. */
export async function hasCompletedTranscode(bucket: R2Bucket, root: string, videoFolder: string): Promise<boolean> {
	return (await bucket.head(markerKey(root, videoFolder))) !== null;
}
