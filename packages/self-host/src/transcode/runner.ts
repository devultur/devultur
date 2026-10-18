// Where the transcode script runs. The script (script.ts) is already provider-agnostic: everything comes in
// through env and state goes out through signed webhooks, so a runner just has to start it somewhere with
// ffmpeg + curl (the `infra/transcode/Dockerfile` image). We never poll the provider's machine state:
// the job's source of truth is the webhooks (see status.ts).

export const TranscodeRunnerName = {
	FLY: "fly",
	CLOUDFLARE: "cloudflare",
	HTTP: "http",
} as const;

export type TranscodeRunnerName = (typeof TranscodeRunnerName)[keyof typeof TranscodeRunnerName];

/** Env with the script in base64: runners that don't embed it in the command (container, HTTP) read it from here. */
export const SCRIPT_ENV_VAR = "TRANSCODE_SCRIPT_B64";

/** `sh -c` command that decodes and runs the script from `TRANSCODE_SCRIPT_B64`. */
export const RUN_SCRIPT_COMMAND = `echo "$${SCRIPT_ENV_VAR}" | base64 -d | sh`;

export interface TranscodeJob {
	videoId: string;
	/** Script `sh` generado por buildScript(). */
	script: string;
	/** Script env (INPUT_KEY, WORKER_URL, CALLBACK_*, …). Strings, without the script. */
	env: Record<string, string>;
}

/**
 * Stable code for a failed launch: it's the only thing (along with the generic `error`) the client sees. `detail`
 * carries the provider's body/exception (Fly, HTTP runner, Cloudflare) and is only logged: it can leak ids and quotas.
 */
export const TranscodeLaunchErrorCode = {
	NOT_CONFIGURED: "transcode_not_configured",
	/** No capacity right now (429/5xx exhausted, runner down): retriable (503). */
	UNAVAILABLE: "transcode_runner_unavailable",
	/** The provider rejected the job (4xx): retrying won't fix it (500). */
	LAUNCH_FAILED: "transcode_launch_failed",
} as const;

export type TranscodeLaunchErrorCode = (typeof TranscodeLaunchErrorCode)[keyof typeof TranscodeLaunchErrorCode];

/** Launch failure. `detail` is server-logs-only: it never goes in the response or in webhooks. */
export interface LaunchFailure {
	ok: false;
	status: 500 | 503;
	error: string;
	code: TranscodeLaunchErrorCode;
	detail: string;
}

export type LaunchResult = { ok: true; jobRef: string } | LaunchFailure;

/** Runner without its config (missing env/binding). The detail names the variables: logs-only. */
export function notConfigured(detail: string): LaunchFailure {
	return {
		ok: false,
		status: 500,
		error: "Transcode runner not configured",
		code: TranscodeLaunchErrorCode.NOT_CONFIGURED,
		detail,
	};
}

/** Code for a failed launch based on its status: 503 = retriable, 500 = rejected. */
export function launchErrorCode(status: 500 | 503): TranscodeLaunchErrorCode {
	return status === 503 ? TranscodeLaunchErrorCode.UNAVAILABLE : TranscodeLaunchErrorCode.LAUNCH_FAILED;
}

export interface TranscodeRunner {
	readonly name: TranscodeRunnerName;
	/** vCPUs the job gets (for the `encodeSeconds × cpus` measurement; 0 = unknown). */
	readonly cpus: number;
	launch(job: TranscodeJob): Promise<LaunchResult>;
	cancel?(jobRef: string): Promise<void>;
}

/** Job env with the script included as `TRANSCODE_SCRIPT_B64` (for runners that read it from env). */
export function envWithScript(job: TranscodeJob): Record<string, string> {
	return { ...job.env, [SCRIPT_ENV_VAR]: btoa(job.script) };
}

/** Reads `TRANSCODE_RUNNER`. Empty → `cloudflare` (no external accounts); unknown value → null (config error). */
export function parseRunnerName(raw: string | undefined): TranscodeRunnerName | null {
	const value = raw?.trim().toLowerCase();
	if (!value) return TranscodeRunnerName.CLOUDFLARE;
	const names: readonly string[] = Object.values(TranscodeRunnerName);
	return names.includes(value) ? (value as TranscodeRunnerName) : null;
}
