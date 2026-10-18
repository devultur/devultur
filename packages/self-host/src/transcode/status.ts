// Job status derived from the script's webhooks (not the provider's): works the same for Fly, a
// container or a VPS, and distinguishes a failure from a success (a failed Fly machine also ended up `stopped`).
// Only written on transitions (queued → running → completed | failed), never on every progress tick.
import { TranscodeStatus } from "@devultur/core";
import { KV_JOB_TTL_SECONDS, KvPrefix } from "../helpers";

export interface TranscodeStatusRecord {
	status: TranscodeStatus;
	/** Job that wrote the record: re-transcoding the same video doesn't inherit the previous job's status. */
	jobRef: string;
	runner?: string;
	error?: string;
	reason?: string;
	retriable?: boolean;
	updatedAt: number;
}

type StatusChange = Omit<TranscodeStatusRecord, "jobRef" | "runner" | "updatedAt">;

const statusKey = (videoId: string) => `${KvPrefix.TRANSCODE_STATUS}:${videoId}`;

/** Transition triggered by a script event, or null if the status doesn't change (intermediate progress). */
export function statusChangeFor(event: Record<string, unknown>): StatusChange | null {
	switch (event.event) {
		case "transcode.started":
			return { status: TranscodeStatus.RUNNING };
		case "transcode.progress":
			// The first heartbeat (before downloading the input) is the signal that "the runner started".
			return event.phase === "downloading" ? { status: TranscodeStatus.RUNNING } : null;
		case "transcode.complete":
			return { status: TranscodeStatus.COMPLETED };
		case "transcode.failed":
			return {
				status: TranscodeStatus.FAILED,
				...(typeof event.error === "string" ? { error: event.error } : {}),
				...(typeof event.reason === "string" ? { reason: event.reason } : {}),
				...(typeof event.retriable === "boolean" ? { retriable: event.retriable } : {}),
			};
		default:
			return null;
	}
}

export async function readStatus(kv: KVNamespace, videoId: string): Promise<TranscodeStatusRecord | null> {
	return kv.get<TranscodeStatusRecord>(statusKey(videoId), "json");
}

/** On launch: `queued` tied to this job. */
export async function writeQueuedStatus(
	kv: KVNamespace,
	videoId: string,
	job: { jobRef: string; runner: string },
): Promise<void> {
	const record: TranscodeStatusRecord = { status: TranscodeStatus.QUEUED, ...job, updatedAt: Date.now() };
	await kv.put(statusKey(videoId), JSON.stringify(record), { expirationTtl: KV_JOB_TTL_SECONDS });
}

/** Applies a webhook's transition, keeping the job. No-op without a prior record (stale job). */
export async function applyStatusEvent(kv: KVNamespace, event: Record<string, unknown>): Promise<void> {
	const change = statusChangeFor(event);
	const videoId = typeof event.videoId === "string" ? event.videoId : "";
	if (!change || !videoId) return;

	const current = await readStatus(kv, videoId);
	if (!current) return;
	// A late `failed` (e.g. the container-crash notice) doesn't clobber a `completed`.
	if (current.status === TranscodeStatus.COMPLETED) return;

	const record: TranscodeStatusRecord = {
		jobRef: current.jobRef,
		...(current.runner ? { runner: current.runner } : {}),
		...change,
		updatedAt: Date.now(),
	};
	await kv.put(statusKey(videoId), JSON.stringify(record), { expirationTtl: KV_JOB_TTL_SECONDS });
}
