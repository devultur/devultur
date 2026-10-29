// The webhook of a transcode job's scope, kept per video at launch: the runner's callbacks carry no scope of their own,
// yet `original-deleted` and the opted-in `transcode.*` events must reach the endpoint of whoever launched the job.
// Only the scope is stored; its URL and secrets are resolved when the callback arrives.
import type { WorkerEnv } from "../types";
import { type WebhookTarget, type WebhookTargetResolver, webhookTargetOfScope } from "./target";

const JOB_TARGET_PREFIX = "webhook-target:";
// Like the job's other KV records: a callback after a day finds none and uses the callback request's own webhook.
const JOB_TARGET_TTL_SECONDS = 86400;

/** Stores the scope of the webhook launching `videoId`'s transcode (or clears it, with no target). */
export async function rememberJobTarget(kv: KVNamespace, videoId: string, target: WebhookTarget | null): Promise<void> {
	const key = `${JOB_TARGET_PREFIX}${videoId}`;
	if (!target) {
		await kv.delete(key);
		return;
	}
	await kv.put(key, JSON.stringify({ scope: target.scope }), { expirationTtl: JOB_TARGET_TTL_SECONDS });
}

/**
 * The webhook of the scope the launch stored for `videoId`, resolved now: undefined when none was stored (then the
 * callback's own scope decides), null when the scope no longer resolves (then nothing is sent).
 */
export async function readJobTarget(
	env: WorkerEnv,
	videoId: string,
	resolvers: readonly WebhookTargetResolver[],
): Promise<WebhookTarget | null | undefined> {
	const stored = await env.MEDIA_KV.get<{ scope?: unknown }>(`${JOB_TARGET_PREFIX}${videoId}`, "json");
	if (typeof stored?.scope !== "string") return undefined;
	return webhookTargetOfScope(env, stored.scope, resolvers);
}
