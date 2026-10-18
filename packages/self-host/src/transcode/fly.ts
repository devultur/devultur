// Fly Machines: one ephemeral machine per job (`auto_destroy`, no restart). The Fly-specific bits live here:
// machine sizing, resuming a suspended app, and retrying 429/5xx from the control API.
import type { FlyMachine, WorkerEnv } from "../types";
import { fetchWithRetry, type RetryOptions } from "./retry";
import {
	type LaunchFailure,
	type LaunchResult,
	launchErrorCode,
	notConfigured,
	type TranscodeJob,
	TranscodeLaunchErrorCode,
	type TranscodeRunner,
	TranscodeRunnerName,
} from "./runner";

export const FLY_API_BASE = "https://api.machines.dev/v1";

export interface FlyGuest {
	cpu_kind: string;
	cpus: number;
	memory_mb: number;
}

// `performance-4x`: 4 dedicated vCPU, 8 GB. The `shared` type has a 6.25% base quota, and FFmpeg (which
// saturates the CPU) gets throttled within seconds on a fresh machine → minutes of wall time per minute of
// video.
export const DEFAULT_FLY_GUEST: FlyGuest = { cpu_kind: "performance", cpus: 4, memory_mb: 8192 };

type FlyGuestEnv = Pick<WorkerEnv, "FLY_TRANSCODE_CPU_KIND" | "FLY_TRANSCODE_CPUS" | "FLY_TRANSCODE_MEMORY_MB">;
type FlyEnv = FlyGuestEnv & Pick<WorkerEnv, "FLY_API_TOKEN" | "FLY_APP_NAME" | "FLY_TRANSCODE_IMAGE" | "FLY_REGION">;

function positiveInt(raw: string | undefined, fallback: number): number {
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Machine guest: defaults from `DEFAULT_FLY_GUEST`, each field overridable via env vars (invalid → default). */
export function flyGuestFromEnv(env: FlyGuestEnv): FlyGuest {
	return {
		cpu_kind: env.FLY_TRANSCODE_CPU_KIND?.trim() || DEFAULT_FLY_GUEST.cpu_kind,
		cpus: positiveInt(env.FLY_TRANSCODE_CPUS, DEFAULT_FLY_GUEST.cpus),
		memory_mb: positiveInt(env.FLY_TRANSCODE_MEMORY_MB, DEFAULT_FLY_GUEST.memory_mb),
	};
}

export interface FlyMachineRequest {
	appName: string;
	apiToken: string;
	image: string;
	guest: FlyGuest;
	env: Record<string, string>;
	script: string;
	/** Machine region. Absent → the body omits it and Fly picks one. */
	region?: string;
}

export type FlyLaunchResult = { ok: true; machine: FlyMachine } | LaunchFailure;

export function flyMachinePayload(request: FlyMachineRequest): string {
	return JSON.stringify({
		config: {
			image: request.image,
			guest: request.guest,
			auto_destroy: true,
			restart: { policy: "no" },
			env: request.env,
			init: { cmd: [`echo '${btoa(request.script)}' | base64 -d | sh`] },
		},
		...(request.region ? { region: request.region } : {}),
	});
}

async function resumeFlyApp(appName: string, apiToken: string): Promise<boolean> {
	const headers = { Authorization: `Bearer ${apiToken}` };
	const response = await fetch(`${FLY_API_BASE}/apps/${appName}`, { method: "GET", headers });
	if (!response.ok) return false;

	const app = (await response.json()) as { status: string };
	if (app.status !== "suspended") return true;

	const resumeResponse = await fetch(`${FLY_API_BASE}/apps/${appName}`, {
		method: "PUT",
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify({ status: "deployed" }),
	});
	if (!resumeResponse.ok) return false;

	// Fly takes a moment to resume before it accepts new machines.
	await new Promise((resolve) => setTimeout(resolve, 2000));
	return true;
}

function postMachine(request: FlyMachineRequest, retry: RetryOptions | undefined): Promise<Response> {
	const body = flyMachinePayload(request);
	return fetchWithRetry(
		() =>
			fetch(`${FLY_API_BASE}/apps/${request.appName}/machines`, {
				method: "POST",
				headers: { Authorization: `Bearer ${request.apiToken}`, "Content-Type": "application/json" },
				body,
			}),
		retry,
	);
}

async function failure(response: Response, error: string): Promise<FlyLaunchResult> {
	const detail = await response.text();
	// Exhausting the 429/5xx retries = no capacity right now (503, retriable by the client).
	const status = response.status === 429 || response.status >= 500 ? 503 : 500;
	console.error(`[transcode] fly: ${error} (status ${response.status}):`, detail);
	return { ok: false, status, error, code: launchErrorCode(status), detail };
}

/**
 * Creates the machine. 429/5xx get retried with backoff (see retry.ts); 412/"suspended" resumes the app and
 * tries again. Never throws on a non-2xx: returns `{ ok: false }` with the detail so it fails loud.
 */
export async function createFlyMachine(request: FlyMachineRequest, retry?: RetryOptions): Promise<FlyLaunchResult> {
	const response = await postMachine(request, retry);
	if (response.ok) return { ok: true, machine: (await response.json()) as FlyMachine };

	const errorBody = await response.text();
	const isSuspended = response.status === 412 || errorBody.includes("suspended");
	if (!isSuspended) {
		return failure(new Response(errorBody, { status: response.status }), "Failed to create transcode job");
	}

	if (!(await resumeFlyApp(request.appName, request.apiToken))) {
		console.error("[transcode] fly: failed to resume suspended app:", errorBody);
		return {
			ok: false,
			status: 503,
			error: "Failed to resume transcode app",
			code: TranscodeLaunchErrorCode.UNAVAILABLE,
			detail: errorBody,
		};
	}

	const retried = await postMachine(request, retry);
	if (retried.ok) return { ok: true, machine: (await retried.json()) as FlyMachine };
	return failure(retried, "Failed to create transcode job after resume");
}

/** Runner on top of Fly Machines: one ephemeral machine per job; `jobRef` = the machine's id. */
export function createFlyRunner(env: FlyEnv, retry?: RetryOptions): TranscodeRunner {
	const guest = flyGuestFromEnv(env);
	const appName = env.FLY_APP_NAME ?? "";
	const apiToken = env.FLY_API_TOKEN ?? "";
	const region = env.FLY_REGION?.trim() || undefined;

	async function launch(job: TranscodeJob): Promise<LaunchResult> {
		if (!appName || !apiToken || !env.FLY_TRANSCODE_IMAGE) {
			const detail = "FLY_APP_NAME, FLY_API_TOKEN and FLY_TRANSCODE_IMAGE are required for TRANSCODE_RUNNER=fly";
			return notConfigured(detail);
		}
		const result = await createFlyMachine(
			{ appName, apiToken, image: env.FLY_TRANSCODE_IMAGE, guest, env: job.env, script: job.script, region },
			retry,
		);
		if (!result.ok) return result;
		return { ok: true, jobRef: result.machine.id };
	}

	async function cancel(jobRef: string): Promise<void> {
		await fetch(`${FLY_API_BASE}/apps/${appName}/machines/${jobRef}?force=true`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${apiToken}` },
		});
	}

	return { name: TranscodeRunnerName.FLY, cpus: guest.cpus, launch, cancel };
}
