// Reading a Worker refusal in your app. Component actions (`components.devultur.*`, and the functions
// `defineDevulturFunctions` and `exposeApi` return) throw `ConvexError<DevulturErrorData>` when the media Worker refuses
// a request (`describeDevulturError` turns one into a message for your users):
//
// ```ts
// try {
//   await devultur.setLock(ctx, key, { until });
// } catch (error) {
//   const refusal = devulturErrorOf(error);
//   if (refusal?.code === "compliance_extend_only") ...
//   throw error;
// }
// ```
import { ConvexError } from "convex/values";
import type { DevulturErrorData } from "./component/workerErrors";

export type { DevulturErrorData };

function isErrorData(data: unknown): data is DevulturErrorData {
	if (typeof data !== "object" || data === null) return false;
	const fields = data as Record<string, unknown>;
	return typeof fields.code === "string" && typeof fields.status === "number" && typeof fields.message === "string";
}

/** True when `error` is a Worker refusal from a component action. */
export function isDevulturError(error: unknown): error is ConvexError<DevulturErrorData & Record<string, never>> {
	return error instanceof ConvexError && isErrorData(error.data);
}

/** The refusal's `{ code, message, status, details? }`, or `null` when `error` isn't one. */
export function devulturErrorOf(error: unknown): DevulturErrorData | null {
	return isDevulturError(error) ? (error.data as DevulturErrorData) : null;
}
