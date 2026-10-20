// Worker errors across the component boundary. A plain `Error` thrown in a component function reaches the app as a
// message only; a `ConvexError` keeps its `data`. Every component action is built with `workerAction`, which rethrows
// the Worker's `DevulturApiError` as `ConvexError<DevulturErrorData>`, so the app reads `error.data.code`
// (`retention_active`, `lock_conflict`, `compliance_extend_only`, ...) and `error.data.details`.
import { DevulturApiError } from "@devultur/core";
import { ConvexError, type Value } from "convex/values";
import { action } from "./_generated/server";

/** `data` of the `ConvexError` a component action throws when the Worker refuses a request. */
export interface DevulturErrorData {
	/** The Worker's stable code (`retention_active`, `file_too_large`, ...), or `worker_error` when it sent none. */
	code: string;
	message: string;
	/** HTTP status of the Worker's answer. */
	status: number;
	/** The rest of the Worker's error body, e.g. `{ key, mode, until, hold }` on `retention_active`. */
	details?: Record<string, Value>;
}

function isApiError(error: unknown): error is DevulturApiError {
	if (error instanceof DevulturApiError) return true;
	// A second copy of `@devultur/core` (bundling) fails `instanceof`; its shape doesn't.
	return (
		error instanceof Error &&
		error.name === "DevulturApiError" &&
		typeof (error as { status?: unknown }).status === "number"
	);
}

/** The error to rethrow: a Worker refusal becomes a `ConvexError` with its code; anything else passes through. */
export function toComponentError(error: unknown): unknown {
	if (!isApiError(error)) return error;
	const data: DevulturErrorData = {
		code: error.code ?? "worker_error",
		message: error.message,
		status: error.status,
		// JSON from the Worker: valid Convex values once `undefined` is gone.
		...(error.details ? { details: JSON.parse(JSON.stringify(error.details)) as Record<string, Value> } : {}),
	};
	return new ConvexError(data as unknown as Value);
}

/** `action` whose handler rethrows Worker refusals as `ConvexError<DevulturErrorData>`. */
export const workerAction = ((definition: { handler: (ctx: unknown, args: unknown) => Promise<unknown> }) =>
	action({
		...definition,
		handler: async (ctx: unknown, args: unknown) => {
			try {
				return await definition.handler(ctx, args);
			} catch (error) {
				throw toComponentError(error);
			}
		},
	} as never)) as unknown as typeof action;
