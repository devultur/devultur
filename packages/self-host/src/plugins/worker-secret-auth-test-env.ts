import type { MiddlewareHandler } from "hono";
import { createWorker } from "../index";
import { defaultPlugins } from "./index";

// Test support for the `worker-secret` auth of `createWorker()`: the env secrets and the backend bearer.
export const TEST_WORKER_SECRET = "test-worker-secret";

/** Authenticates the backend and the transcode webhooks (same value for both keeps the tests short). */
export const WORKER_SECRETS = {
	WORKER_AUTH_SECRET: TEST_WORKER_SECRET,
	TRANSCODE_WEBHOOK_SECRET: TEST_WORKER_SECRET,
};

/** `init` with the backend bearer, keeping any header it already has. */
export function withWorkerAuth(init: RequestInit = {}): RequestInit {
	const headers = new Headers(init.headers);
	if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${TEST_WORKER_SECRET}`);
	return { ...init, headers };
}

/** A Worker with the default plugins and a test plugin that runs `afterAuth` after authentication. */
export function workerWithMiddleware(...afterAuth: MiddlewareHandler[]) {
	return createWorker({ plugins: [...defaultPlugins(), { name: "test", middleware: { afterAuth } }] });
}
