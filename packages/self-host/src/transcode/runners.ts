import type { WorkerEnv } from "../types";
import { createCloudflareContainerRunner } from "./cloudflare";
import { createFlyRunner } from "./fly";
import { createHttpRunner } from "./http";
import { parseRunnerName, type TranscodeRunner, TranscodeRunnerName } from "./runner";

/**
 * Runner based on `TRANSCODE_RUNNER` (`fly` | `cloudflare` | `http`; empty = `cloudflare`). Null if the value is unknown: a config error the route reports instead of guessing.
 */
export function createRunner(env: WorkerEnv): TranscodeRunner | null {
	switch (parseRunnerName(env.TRANSCODE_RUNNER)) {
		case TranscodeRunnerName.FLY:
			return createFlyRunner(env);
		case TranscodeRunnerName.CLOUDFLARE:
			return createCloudflareContainerRunner(env);
		case TranscodeRunnerName.HTTP:
			return createHttpRunner(env);
		default:
			return null;
	}
}
