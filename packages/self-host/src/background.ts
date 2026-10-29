// Work that runs after the response (audit records, webhook deliveries): handed to the runtime's `waitUntil`, or
// awaited where there's no execution context (a test, a call outside a request).
import type { Context } from "hono";

// biome-ignore lint/suspicious/noExplicitAny: any app that mounts the Worker (its own bindings and variables)
type AnyContext = Context<any>;

/** Runs `task` after the response when the runtime allows it; otherwise (no execution context) waits for it. */
export async function inBackground(context: AnyContext, task: Promise<void>): Promise<void> {
	let executionCtx: { waitUntil: (task: Promise<unknown>) => void } | undefined;
	try {
		executionCtx = context.executionCtx;
	} catch {}
	if (!executionCtx) return task;
	executionCtx.waitUntil(task);
}
