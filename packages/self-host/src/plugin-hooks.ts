// Plugin hooks: decisions plugins take at fixed points of a route, with the request's context. `createWorker()` runs
// the hooks of every plugin in order and hands the composed result to the routes through a context variable.
import type { Context } from "hono";
import type { Json } from "./request-state";
import type { DownloadLinkInfo } from "./route-result";

/** What is being issued: a viewer token, an upload token, a download link or the transcode runner's token. */
export type CredentialKind = "viewer" | "upload" | "download-link" | "service";

export interface CredentialRequest {
	kind: CredentialKind;
	/** Scopes the credential will carry. */
	scopes: string[];
	/** What it is bound to: the upload prefix (`asset/…/`), the download link's key or the original being transcoded. */
	path?: string;
	/** Expiry the request asked for (epoch ms). */
	expiresAt: number;
}

export type CredentialDecision =
	/** Refuse: `response` is returned as is. */
	| { allow: false; response: Response }
	/**
	 * Issue it. `expiresAt` (epoch ms) caps the expiry: the Worker uses the earliest of it and the requested one.
	 * `claims` are added to a token's payload (never over the claims the Worker sets itself).
	 */
	| { allow: true; expiresAt?: number; claims?: Record<string, Json> };

export type AllowedCredential = Extract<CredentialDecision, { allow: true }>;

// biome-ignore lint/suspicious/noExplicitAny: any app that mounts the Worker (its own bindings and variables)
type AnyContext = Context<any>;

export type IssueCredentialHook = (
	context: AnyContext,
	request: CredentialRequest,
) => CredentialDecision | Promise<CredentialDecision>;

/** A response refuses the redemption (returned as is, and the use is NOT spent); `null` lets it go on. */
export type BeforeLinkRedeemHook = (
	context: AnyContext,
	link: DownloadLinkInfo,
) => Response | null | Promise<Response | null>;

/** The hooks of every plugin, in plugin order. */
export interface PluginHooks {
	issueCredential: IssueCredentialHook[];
	beforeLinkRedeem: BeforeLinkRedeemHook[];
}

/** Context variable that carries the hooks to the routes. Internal. */
export const PLUGIN_HOOKS_VARIABLE = "pluginHooks";

const NO_HOOKS: PluginHooks = { issueCredential: [], beforeLinkRedeem: [] };

export function getPluginHooks(context: AnyContext): PluginHooks {
	return (context.get(PLUGIN_HOOKS_VARIABLE) as PluginHooks | undefined) ?? NO_HOOKS;
}

const earliest = (current: number | undefined, next: number | undefined) =>
	current === undefined ? next : next === undefined ? current : Math.min(current, next);

/**
 * Runs every `issueCredential` hook in plugin order. The first refusal wins; otherwise the earliest `expiresAt` and the
 * claims of all of them (a later plugin's claim replaces an earlier one with the same name). No hook: allow.
 */
export async function decideCredential(context: AnyContext, request: CredentialRequest): Promise<CredentialDecision> {
	let expiresAt: number | undefined;
	let claims: Record<string, Json> | undefined;
	for (const hook of getPluginHooks(context).issueCredential) {
		const decision = await hook(context, request);
		if (!decision.allow) return decision;
		expiresAt = earliest(expiresAt, decision.expiresAt);
		if (decision.claims) claims = { ...claims, ...decision.claims };
	}
	return { allow: true, ...(expiresAt !== undefined ? { expiresAt } : {}), ...(claims ? { claims } : {}) };
}

/** Runs the `beforeLinkRedeem` hooks in plugin order: the first response refuses. */
export async function gateLinkRedemption(context: AnyContext, link: DownloadLinkInfo): Promise<Response | null> {
	for (const hook of getPluginHooks(context).beforeLinkRedeem) {
		const refusal = await hook(context, link);
		if (refusal) return refusal;
	}
	return null;
}

/** Earliest of a requested expiry and the plugins' cap, in the unit of `requested` (`toUnit` converts the cap). */
export function cappedExpiry(requested: number, cap: number | undefined, toUnit: (epochMs: number) => number): number {
	return cap === undefined ? requested : Math.min(requested, toUnit(cap));
}

/** The plugins' claims under the Worker's own: a plugin can add claims, never replace one the Worker set. */
export function withPluginClaims(
	claims: Record<string, unknown>,
	decision: AllowedCredential,
): Record<string, unknown> {
	return { ...decision.claims, ...claims };
}
