// `staticConfig(config)`: the rules every request starts from (security, upload rules, caption locales, cache rules,
// transcode settings). A later plugin can narrow them per request with `updateRequestState(context, { config })`.
import type { MiddlewareHandler } from "hono";
import type { WorkerPlugin } from "../plugin";
import { updateRequestState, type WorkerConfig } from "../request-state";

/** Applies `config` to every request. Put it first: plugins after it narrow it, field by field. */
export function staticConfig(config: WorkerConfig): WorkerPlugin {
	const applyConfig: MiddlewareHandler = async (context, next) => {
		updateRequestState(context, { config });
		await next();
	};
	return { name: "static-config", middleware: { beforeAuth: [applyConfig] } };
}
