// `staticConfig(config)`: the rules every request starts from (security, upload rules, caption locales, cache rules,
// transcode settings). A later plugin can narrow them per request with `updateRequestState(context, { config })`.
import type { MiddlewareHandler } from "hono";
import { CONFIG_WEBHOOK_SCOPE } from "../media-events/target";
import type { WorkerPlugin } from "../plugin";
import { updateRequestState, type WorkerConfig } from "../request-state";

/**
 * Applies `config` to every request. Put it first: plugins after it narrow it, field by field. It also resolves its
 * `webhooks` by scope at delivery time (queued events, transcode jobs).
 */
export function staticConfig(config: WorkerConfig): WorkerPlugin {
	// Its webhook gets the `config` scope unless it names one: the only webhook that may omit it.
	const webhooks = config.webhooks && { ...config.webhooks, scope: config.webhooks.scope ?? CONFIG_WEBHOOK_SCOPE };
	const scopedConfig: WorkerConfig = webhooks ? { ...config, webhooks } : config;
	const applyConfig: MiddlewareHandler = async (context, next) => {
		updateRequestState(context, { config: scopedConfig });
		await next();
	};
	const webhookScope = webhooks?.scope;
	return {
		name: "static-config",
		middleware: { beforeAuth: [applyConfig] },
		...(webhooks ? { resolveWebhookTarget: (_env, scope) => (scope === webhookScope ? webhooks : null) } : {}),
	};
}
