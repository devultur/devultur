// Runner on top of Cloudflare Containers (GA 2026-04): a `TranscodeContainer` Durable Object per video starts
// the same image (`infra/transcode/Dockerfile`) with `ctx.container.start()` and the `durable_object`
// scheduling policy (image and instance chosen at runtime). Same deployment and same account as the Worker.
// The DO class lives in container.ts (it imports `cloudflare:workers`); the testable bits live here.
import { JOB_TICKET_HEADER } from "./job-ticket";
import {
	envWithScript,
	type LaunchResult,
	notConfigured,
	RUN_SCRIPT_COMMAND,
	type TranscodeJob,
	TranscodeLaunchErrorCode,
	type TranscodeRunner,
} from "./runner";

/** Name of the image in `[containers.images.<name>]` in wrangler.toml. */
export const CONTAINER_IMAGE_NAME = "transcode";
export const DEFAULT_CF_INSTANCE = "standard-4";
const JOB_REF_PREFIX = "cf-";

// vCPU per instance type (developers.cloudflare.com/containers/platform-details/limits, 2026-10).
const INSTANCE_VCPUS: Record<string, number> = {
	lite: 1 / 16,
	basic: 1 / 4,
	"standard-1": 1 / 2,
	"standard-2": 1,
	"standard-3": 2,
	"standard-4": 4,
};

export interface ContainerLaunchRequest {
	env: Record<string, string>;
	instance: string;
}

export interface ContainerLaunchResult {
	alreadyRunning: boolean;
}

/** RPC surface of the DO (what the Worker calls on the stub). */
export interface TranscodeContainerRpc {
	launch(request: ContainerLaunchRequest): Promise<ContainerLaunchResult>;
	cancel(): Promise<void>;
}

/** `TRANSCODE_CONTAINER` binding (DurableObjectNamespace<TranscodeContainer>), typed by what's actually used. */
export interface TranscodeContainerNamespace {
	idFromName(name: string): DurableObjectId;
	get(id: DurableObjectId): TranscodeContainerRpc;
}

interface CloudflareRunnerEnv {
	TRANSCODE_CONTAINER?: TranscodeContainerNamespace;
	CF_TRANSCODE_INSTANCE?: string;
}

/** One DO per video: relaunching the same video while it's running doesn't start a second container. */
export function createCloudflareContainerRunner(env: CloudflareRunnerEnv): TranscodeRunner {
	const instance = env.CF_TRANSCODE_INSTANCE?.trim() || DEFAULT_CF_INSTANCE;
	const namespace = env.TRANSCODE_CONTAINER;
	const stubFor = (videoId: string) => namespace?.get(namespace.idFromName(videoId));

	async function launch(job: TranscodeJob): Promise<LaunchResult> {
		const stub = stubFor(job.videoId);
		if (!stub) return notConfigured("TRANSCODE_CONTAINER binding is required for TRANSCODE_RUNNER=cloudflare");
		if (!(instance in INSTANCE_VCPUS)) return notConfigured(`Unknown CF_TRANSCODE_INSTANCE "${instance}"`);

		try {
			const result = await stub.launch({ env: envWithScript(job), instance });
			if (result.alreadyRunning) console.warn(`[transcode] cloudflare: ${job.videoId} already running, reusing it`);
			return { ok: true, jobRef: `${JOB_REF_PREFIX}${job.videoId}` };
		} catch (error) {
			console.error("[transcode] cloudflare: container launch failed:", error);
			return {
				ok: false,
				status: 503,
				error: "Failed to start transcode container",
				code: TranscodeLaunchErrorCode.UNAVAILABLE,
				detail: String(error),
			};
		}
	}

	async function cancel(jobRef: string): Promise<void> {
		await stubFor(jobRef.replace(JOB_REF_PREFIX, ""))?.cancel();
	}

	return { name: "cloudflare", cpus: INSTANCE_VCPUS[instance] ?? 0, launch, cancel };
}

// --- Durable Object side (used by container.ts) ---

/** `ctx.container` with the `durable_object` policy API (workers-types doesn't ship it yet). */
export interface ContainerHandle {
	readonly running: boolean;
	readonly images?: Record<string, string>;
	start(options: {
		image?: string;
		instance?: string;
		enableInternet: boolean;
		entrypoint?: string[];
		env?: Record<string, string>;
	}): void;
	monitor(): Promise<void>;
	destroy(error?: unknown): Promise<void>;
}

/** Starts the container if it isn't already running. Returns the exit promise (`monitor()`) to watch it. */
export function startTranscodeContainer(
	container: ContainerHandle | undefined,
	request: ContainerLaunchRequest,
): { alreadyRunning: boolean; exited: Promise<void> | null } {
	if (!container) throw new Error("Containers are not configured for this Durable Object (see [[containers]])");
	if (container.running) return { alreadyRunning: true, exited: null };

	const image = container.images?.[CONTAINER_IMAGE_NAME];
	if (!image) throw new Error(`Missing [containers.images.${CONTAINER_IMAGE_NAME}] in the wrangler config`);

	container.start({
		image,
		instance: request.instance,
		// Downloads the raw and uploads the renditions over HTTP to the Worker → needs internet egress.
		enableInternet: true,
		entrypoint: ["sh", "-c", RUN_SCRIPT_COMMAND],
		env: request.env,
	});
	return { alreadyRunning: false, exited: container.monitor() };
}

function exitCodeOf(error: unknown): number | undefined {
	const exitCode = (error as { exitCode?: unknown } | null)?.exitCode;
	return typeof exitCode === "number" ? exitCode : undefined;
}

/**
 * Did the exit go unreported by the script? An exit 1..127 goes through the script's `trap`, which already
 * sent `transcode.failed`. A signal (≥128: OOM-kill 137, SIGTERM 143 from a host restart) or a stop with no
 * exit code kills `sh` without the trap → we have to report it from outside so the video doesn't get stuck
 * in "transcoding".
 */
export function isUnreportedCrash(error: unknown): boolean {
	const exitCode = exitCodeOf(error);
	return exitCode === undefined || exitCode >= 128;
}

/** Emits `transcode.failed` to the Worker's webhook with the same CALLBACK_* values the script uses. */
export async function reportContainerCrash(env: Record<string, string>, error: unknown): Promise<void> {
	if (!env.CALLBACK_URL || !env.VIDEO_ID) return;
	const exitCode = exitCodeOf(error);
	await fetch(env.CALLBACK_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${env.CALLBACK_SECRET ?? ""}`,
			...(env.JOB_TICKET ? { [JOB_TICKET_HEADER]: env.JOB_TICKET } : {}),
		},
		body: JSON.stringify({
			event: "transcode.failed",
			videoId: env.VIDEO_ID,
			// The runtime text doesn't travel: this event gets forwarded to the client's webhook. It was already logged in watchContainer.
			error: `transcode container stopped (${exitCode === undefined ? "unexpectedly" : `exit ${exitCode}`})`,
			reason: "internal",
			retriable: true,
		}),
	});
}

/** Waits for the container to exit and reports the crashes the script didn't manage to report. */
export async function watchContainer(exited: Promise<void>, env: Record<string, string>): Promise<void> {
	try {
		await exited;
	} catch (error) {
		if (!isUnreportedCrash(error)) return;
		console.error("[transcode] cloudflare: container crashed:", error);
		await reportContainerCrash(env, error).catch((reportError) =>
			console.error("[transcode] cloudflare: crash report failed:", reportError),
		);
	}
}
