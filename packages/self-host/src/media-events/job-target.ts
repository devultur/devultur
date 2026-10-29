// The webhook of a transcode job's scope, kept per video at launch: the runner's callbacks carry no scope of their own,
// yet `original-deleted` and the opted-in `transcode.*` events must reach the endpoint of whoever launched the job.
import type { WebhookTarget } from "./target";

const JOB_TARGET_PREFIX = "webhook-target:";
// Like the job's other KV records: a callback after a day finds none and uses the Worker's own webhook.
const JOB_TARGET_TTL_SECONDS = 86400;

/** Stores (or, with no target, clears) the webhook of the scope launching `videoId`'s transcode. */
export async function rememberJobTarget(kv: KVNamespace, videoId: string, target: WebhookTarget | null): Promise<void> {
	const key = `${JOB_TARGET_PREFIX}${videoId}`;
	if (!target) {
		await kv.delete(key);
		return;
	}
	await kv.put(key, JSON.stringify(target), { expirationTtl: JOB_TARGET_TTL_SECONDS });
}

/** The webhook the launch stored for `videoId`, or undefined (then the callback's own scope decides). */
export async function readJobTarget(kv: KVNamespace, videoId: string): Promise<WebhookTarget | undefined> {
	return (await kv.get<WebhookTarget>(`${JOB_TARGET_PREFIX}${videoId}`, "json")) ?? undefined;
}
