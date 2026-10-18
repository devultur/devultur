// Generic HTTP runner: POSTs the job to your own endpoint (a VPS with Docker, a queue, local dev) with
// a shared bearer. The receiver just runs `command` with `env` (the reference implementation is in
// infra/transcode/http-runner/). Same as the other runners, status comes back through the script's webhooks.
import { fetchWithRetry, isRetryableStatus, type RetryOptions } from "./retry";
import {
	envWithScript,
	type LaunchResult,
	launchErrorCode,
	notConfigured,
	RUN_SCRIPT_COMMAND,
	type TranscodeJob,
	TranscodeLaunchErrorCode,
	type TranscodeRunner,
} from "./runner";

export const HTTP_RUNNER_PROTOCOL_VERSION = 1;
const JOB_REF_PREFIX = "http-";

/** Body of the POST to the runner. `env` carries the script in `TRANSCODE_SCRIPT_B64` and secrets: HTTPS only. */
export interface HttpRunnerJobRequest {
	version: typeof HTTP_RUNNER_PROTOCOL_VERSION;
	videoId: string;
	command: string[];
	env: Record<string, string>;
}

interface HttpRunnerEnv {
	TRANSCODE_RUNNER_URL?: string;
	TRANSCODE_RUNNER_SECRET?: string;
	TRANSCODE_RUNNER_CPUS?: string;
}

function cpusFrom(raw: string | undefined): number {
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function jobRefFrom(response: Response, videoId: string): Promise<string> {
	const body = (await response.json().catch(() => null)) as { jobId?: unknown } | null;
	return typeof body?.jobId === "string" && body.jobId ? body.jobId : `${JOB_REF_PREFIX}${videoId}`;
}

export function createHttpRunner(env: HttpRunnerEnv, retry?: RetryOptions): TranscodeRunner {
	const url = env.TRANSCODE_RUNNER_URL?.trim().replace(/\/$/, "") ?? "";
	const secret = env.TRANSCODE_RUNNER_SECRET ?? "";
	const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };

	async function launch(job: TranscodeJob): Promise<LaunchResult> {
		if (!url || !secret) {
			const detail = "TRANSCODE_RUNNER_URL and TRANSCODE_RUNNER_SECRET are required for TRANSCODE_RUNNER=http";
			return notConfigured(detail);
		}
		const request: HttpRunnerJobRequest = {
			version: HTTP_RUNNER_PROTOCOL_VERSION,
			videoId: job.videoId,
			command: ["sh", "-c", RUN_SCRIPT_COMMAND],
			env: envWithScript(job),
		};
		const body = JSON.stringify(request);

		let response: Response;
		try {
			response = await fetchWithRetry(() => fetch(url, { method: "POST", headers, body }), retry);
		} catch (error) {
			console.error("[transcode] http runner unreachable:", error);
			return {
				ok: false,
				status: 503,
				error: "Transcode runner unreachable",
				code: TranscodeLaunchErrorCode.UNAVAILABLE,
				detail: String(error),
			};
		}
		if (response.ok) return { ok: true, jobRef: await jobRefFrom(response, job.videoId) };

		const detail = await response.text();
		console.error(`[transcode] http runner rejected the job (status ${response.status}):`, detail);
		const status = isRetryableStatus(response.status) ? 503 : 500;
		return { ok: false, status, error: "Transcode runner rejected the job", code: launchErrorCode(status), detail };
	}

	async function cancel(jobRef: string): Promise<void> {
		await fetch(`${url}/${encodeURIComponent(jobRef)}`, { method: "DELETE", headers });
	}

	return { name: "http", cpus: cpusFrom(env.TRANSCODE_RUNNER_CPUS), launch, cancel };
}
