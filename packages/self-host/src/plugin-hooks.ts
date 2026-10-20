// Plugin hooks: decisions plugins take at fixed points of a route, with the request's context. `createWorker()` runs
// the hooks of every plugin in order and hands the composed result to the routes through a context variable.
import type { ObjectLock } from "@devultur/core";
import type { Context } from "hono";
import type { LockAuditRecord } from "./object-lock/audit";
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

/** What a lock change does: `set` a first (or expired) retention, `extend` it, `shorten` or `remove` it. */
export type LockChangeAction = "set" | "extend" | "shorten" | "remove";

export interface LockChangeRequest {
	action: LockChangeAction;
	/** The virtual keys it changes. */
	keys: string[];
	before: ObjectLock | null;
	after: ObjectLock | null;
}

export type LockChangeDecision = { allow: false; response: Response } | { allow: true };

/**
 * Before the Worker changes a lock. Refuse with a response, or allow. Approving a governance `shorten`/`remove` asked
 * with `bypassGovernance` takes at least one of these hooks, and all of them must allow it (decision 4 of #3).
 */
export type AuthorizeLockChangeHook = (
	context: AnyContext,
	request: LockChangeRequest,
) => LockChangeDecision | Promise<LockChangeDecision>;

/** After a lock event (change, rejected delete or overwrite, retained original), to store the record elsewhere. */
export type OnLockAuditHook = (context: AnyContext, record: LockAuditRecord) => void | Promise<void>;

/** The hooks of every plugin, in plugin order. */
export interface PluginHooks {
	issueCredential: IssueCredentialHook[];
	beforeLinkRedeem: BeforeLinkRedeemHook[];
	authorizeLockChange: AuthorizeLockChangeHook[];
	onLockAudit: OnLockAuditHook[];
}

/** Context variable that carries the hooks to the routes. Internal. */
export const PLUGIN_HOOKS_VARIABLE = "pluginHooks";

const NO_HOOKS: PluginHooks = { issueCredential: [], beforeLinkRedeem: [], authorizeLockChange: [], onLockAudit: [] };

export function getPluginHooks(context: AnyContext): PluginHooks {
	// Merged over the empty set: a mount that only provides some hooks (a test, an older composer) still works.
	return { ...NO_HOOKS, ...(context.get(PLUGIN_HOOKS_VARIABLE) as Partial<PluginHooks> | undefined) };
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

/**
 * Runs the `authorizeLockChange` hooks in plugin order: the first refusal wins. `isApproved`: at least one hook ran and
 * all allowed, which is what a governance bypass needs. No hook: allowed, but not approved.
 */
export async function decideLockChange(
	context: AnyContext,
	request: LockChangeRequest,
): Promise<{ allow: false; response: Response } | { allow: true; isApproved: boolean }> {
	const hooks = getPluginHooks(context).authorizeLockChange;
	for (const hook of hooks) {
		const decision = await hook(context, request);
		if (!decision.allow) return decision;
	}
	return { allow: true, isApproved: hooks.length > 0 };
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
