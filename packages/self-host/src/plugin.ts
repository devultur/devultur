// Plugins: how the Worker is extended, and how it is built. `createWorker({ plugins })` composes them; the default ones
// (worker-secret auth, static config, credential policy, download links) use the same API as any plugin of yours.
import type { Hono, MiddlewareHandler } from "hono";
import type { WebhookTargetResolver } from "./media-events/target";
import type {
	AuthorizeLockChangeHook,
	BeforeLinkRedeemHook,
	IssueCredentialHook,
	OnLockAuditHook,
	OnMediaEventHook,
	PluginHooks,
} from "./plugin-hooks";

// biome-ignore lint/suspicious/noExplicitAny: a plugin's middleware and routes type their own bindings and variables
type AnyMiddleware = MiddlewareHandler<any>;
// biome-ignore lint/suspicious/noExplicitAny: a plugin's middleware and routes type their own bindings and variables
type AnyApp = Hono<any>;

/**
 * Where a plugin's middleware runs. Every request goes through all plugins' `beforeAuth`, then their `auth`, then
 * their `afterAuth` (each phase in plugin order), and then the route.
 */
export interface PluginMiddleware {
	/** Before authentication: request normalization, routing by host, endpoints a plugin answers on its own. */
	beforeAuth?: AnyMiddleware[];
	/** Authentication: who is calling, and what the request may touch (`updateRequestState`). */
	auth?: AnyMiddleware[];
	/** After authentication: authorization, limits, per-request rules, and work after `await next()` (logs, metrics). */
	afterAuth?: AnyMiddleware[];
}

export interface PluginRoute {
	/** Mount path (`/v1/reports`). Mounted after the Worker's own routes, behind every plugin's middleware. */
	path: string;
	app: AnyApp;
}

export interface WorkerPlugin {
	/** Unique name, for errors and logs. */
	name: string;
	middleware?: PluginMiddleware;
	routes?: PluginRoute[];
	/** Before the Worker issues a viewer token, an upload token, a download link or the runner's service token. */
	issueCredential?: IssueCredentialHook;
	/** Before `GET /v1/download/{id}` spends a use of a link that still has one. */
	beforeLinkRedeem?: BeforeLinkRedeemHook;
	/** Before `PUT /v1/lock` changes a lock: refuse it, or approve a governance bypass. */
	authorizeLockChange?: AuthorizeLockChangeHook;
	/** After every lock event, with its audit record. Runs after the response. */
	onLockAudit?: OnLockAuditHook;
	/** After every media event (deleted, changed), to deliver it your own way: the built-in webhook is then skipped. */
	onMediaEvent?: OnMediaEventHook;
	/**
	 * The webhook of a scope your plugin sets in `config.webhooks.scope`, resolved when an event is delivered (a queued
	 * one, or a transcode's): its URL and current secrets. Return null for a scope that isn't yours.
	 */
	resolveWebhookTarget?: WebhookTargetResolver;
}

export interface ComposedPlugins {
	middleware: AnyMiddleware[];
	routes: PluginRoute[];
	hooks: PluginHooks;
}

const PHASES = ["beforeAuth", "auth", "afterAuth"] as const;

function assertComposable(plugins: readonly WorkerPlugin[]): void {
	const names = new Set<string>();
	for (const plugin of plugins) {
		if (names.has(plugin.name)) throw new Error(`createWorker: two plugins are named "${plugin.name}"`);
		names.add(plugin.name);
	}
	// Fail closed: a Worker without authentication would serve every control route to anyone.
	if (!plugins.some((plugin) => (plugin.middleware?.auth?.length ?? 0) > 0)) {
		throw new Error("createWorker: no plugin authenticates requests. Add workerSecretAuth() or your own auth plugin.");
	}
}

/** Middleware in phase order, routes and hooks of `plugins`. Throws on a duplicate name or no auth plugin. */
export function composePlugins(plugins: readonly WorkerPlugin[]): ComposedPlugins {
	assertComposable(plugins);
	return {
		middleware: PHASES.flatMap((phase) => plugins.flatMap((plugin) => plugin.middleware?.[phase] ?? [])),
		routes: plugins.flatMap((plugin) => plugin.routes ?? []),
		hooks: {
			issueCredential: plugins.flatMap((plugin) => (plugin.issueCredential ? [plugin.issueCredential] : [])),
			beforeLinkRedeem: plugins.flatMap((plugin) => (plugin.beforeLinkRedeem ? [plugin.beforeLinkRedeem] : [])),
			authorizeLockChange: plugins.flatMap((plugin) =>
				plugin.authorizeLockChange ? [plugin.authorizeLockChange] : [],
			),
			onLockAudit: plugins.flatMap((plugin) => (plugin.onLockAudit ? [plugin.onLockAudit] : [])),
			onMediaEvent: plugins.flatMap((plugin) => (plugin.onMediaEvent ? [plugin.onMediaEvent] : [])),
			resolveWebhookTarget: plugins.flatMap((plugin) =>
				plugin.resolveWebhookTarget ? [plugin.resolveWebhookTarget] : [],
			),
		},
	};
}
