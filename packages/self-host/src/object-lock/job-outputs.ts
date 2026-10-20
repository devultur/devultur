// A transcode job writes its outputs (HLS, MP4, thumbnails, storyboard) under the video's folder, and the runner
// retries a failed upload by writing the same key again. While that job is still in progress its outputs aren't
// retained yet, so the runner may overwrite them even when the raw is locked; from `transcode.complete` on they're
// protected like any derived file (`derivatives: "inherit"`). It reads only state the Worker already keeps: the job's
// status record (written `queued` at launch, moved by the runner's webhooks) and the runner's credential.
import { isBearerOf, TranscodeStatus } from "@devultur/core";
import type { Context } from "hono";
import { getRequestState } from "../request-state";
import { isDerivedAssetKey } from "../routes/derived-upload";
import { readStatus } from "../transcode/status";
import type { WorkerApp } from "../types";

const VIDEO_ID = /^(?:public|private)\/video\/([^/]+)\//;
const IN_PROGRESS: ReadonlySet<string> = new Set([TranscodeStatus.QUEUED, TranscodeStatus.RUNNING]);

/**
 * True when `key` (virtual) is an output of the transcode job in progress for its video and the request carries the
 * runner's credential. With `workerSecretAuth()` that credential is the Worker secret, which the backend holds too;
 * an auth plugin that hands the runner a narrower credential narrows this with it.
 */
export async function isInProgressJobOutput(context: Context<WorkerApp>, key: string): Promise<boolean> {
	if (!isDerivedAssetKey(key)) return false;
	if (!isBearerOf(context.req.header("Authorization"), getRequestState(context).runnerCredential)) return false;
	const videoId = VIDEO_ID.exec(key)?.[1];
	if (!videoId) return false;
	const status = await readStatus(context.env.MEDIA_KV, videoId);
	return status !== null && IN_PROGRESS.has(status.status);
}
