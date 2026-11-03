// Request state: everything the plugins tell the routes about the current request, in one context variable. Every
// request starts at the bucket root with no rules; plugins narrow it with `updateRequestState` (for example the storage
// prefix and the rules of whoever the credential belongs to). The routes only read it with `getRequestState`.
import type { CacheRule, ObjectLock, SecurityPolicy, TranscodeSettings, WebhookEventType } from "@devultur/core";
import type { Context } from "hono";
import type { UploadGrant } from "./export-types";
import { assertWebhookScope } from "./media-events/target";
import type { MaxResolution, RawStorageClass, UploadRules } from "./types";

/** Any JSON value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Data that plugins attach to a request. The Worker stores it with the uploads and download links the request creates
 * and in the transcode job ticket, and hands it back when they are used (`getRouteResult`, the pending upload): a
 * credential-less request has nothing else to tell who started it. The Worker never reads it.
 *
 * Augment the interface to type your plugin's keys:
 *
 * ```ts
 * declare module "@devultur/self-host" {
 *   interface PluginContext { appId?: string }
 * }
 * ```
 */
export interface PluginContext {
	[key: string]: Json | undefined;
}

export interface TranscodeConfig {
	/** Named presets and the default one, used when a request names no preset. */
	presets?: TranscodeSettings;
	/** Highest rung of the adaptive ladder. Unset: a `hls-*` alias derives it from its name, a spec asks up to 4k. */
	maxResolution?: MaxResolution;
	/** Delete the original once a transcode completes (never after a failure). Unset: the original is kept. */
	deleteOriginalOnSuccess?: boolean;
	/** Base of the output URLs in the client webhook. Unset: the origin of the transcode request. */
	outputBaseUrl?: string;
}

/**
 * Where the Worker sends its media events (signed, see docs/guides/webhooks.md). Overrides `MEDIA_WEBHOOK_URL` and
 * `MEDIA_WEBHOOK_SECRET` for the request's scope.
 */
export interface WebhookConfig {
	/**
	 * Names this webhook in queued events and transcode jobs, which keep only the scope: its URL and secrets are
	 * resolved again at delivery (`resolveWebhookTarget` of a plugin; `staticConfig` resolves its own). Required, and
	 * unique to this webhook, when a plugin sets it per request: `updateRequestState` throws without one. Only
	 * `defaultPlugins(config)` / `staticConfig(config)` may omit it (they use `config`). `env` is the `MEDIA_WEBHOOK_*`
	 * vars.
	 */
	scope?: string;
	/** An `https` URL on a public host. */
	url: string;
	/** Signing secret (`whsec_<base64>` or any string). Several during a rotation: each one signs. */
	secret: string | string[];
	/**
	 * Events sent. Default `media.deleted` and `media.changed`; list `transcode.*` or `captions.*` types to get those
	 * too, in the same envelope.
	 */
	events?: WebhookEventType[];
	/** Allows `http` and private or loopback hosts. Local development only. */
	allowUnsafeUrl?: boolean;
}

/** Rules the routes enforce. */
export interface WorkerConfig {
	/** Default security policy (session/IP binding, encryption at rest). Unset: secure default. */
	security?: SecurityPolicy;
	/** Per media type: size limit, accepted content types and default visibility. */
	uploadRules?: UploadRules;
	/** Allowed caption locales. Unset or empty: any. */
	captionsLocales?: string[];
	/** `Cache-Control` per prefix of the `asset/` namespace (the longest one wins). */
	cacheRules?: CacheRule[];
	/** R2 storage class of an uploaded video original. Unset: Standard. Fixed at upload time. */
	originalStorageClass?: RawStorageClass;
	/**
	 * Longest lifetime, in seconds, of a file uploaded in the request: it is the default TTL and a shorter `expiresIn`
	 * (or upload token `fileExpiresIn`) still wins. For a demo or scratch Worker whose uploads clean themselves up.
	 * Unset: files only expire when the upload asks for it.
	 */
	maxFileLifetimeSeconds?: number;
	/**
	 * R2 custom metadata added to every object the request uploads (also on the later credential-less PUT), for example
	 * which app or user uploaded it. Keys the Worker owns (integrity `sha256*`, `expiresAt`, `security`, `enc`,
	 * `derivedFrom`, `lock`) are dropped from it.
	 */
	uploadMetadata?: Record<string, string>;
	/**
	 * Default lock of an uploaded file: retention (`governance` or `compliance`, until a date or for a period) and hold.
	 * The upload request (or its upload token) overrides it. Unset: files aren't locked.
	 */
	lock?: ObjectLock;
	transcode?: TranscodeConfig;
	/**
	 * What an upload whose first bytes contradict its declared Content-Type gets (see `ContentSniffingMode`). Every
	 * mismatch is logged (`[content-sniff] {declared, detected, key, action}`). A transcode's outputs are never checked.
	 * Unset: `scriptable`.
	 */
	contentSniffing?: ContentSniffingMode;
	/** Media event webhook of the scope. Unset: `MEDIA_WEBHOOK_URL` / `MEDIA_WEBHOOK_SECRET`, or none. */
	webhooks?: WebhookConfig;
}

/**
 * - `scriptable` (default): `415 content_type_mismatch` only when the bytes are markup (HTML, SVG, XML) under an inert
 *   type; any other mismatch is stored with its declared type.
 * - `reject`: `415` for every mismatch.
 * - `octet-stream`: a single PUT that mismatches is stored as `application/octet-stream`; a multipart upload is
 *   rejected (R2 fixes its type when it starts).
 * - `off`: no check.
 */
export type ContentSniffingMode = "scriptable" | "reject" | "octet-stream" | "off";

/** What an auth plugin established about the request's credential. */
export interface RequestAccess {
	/**
	 * The request's credential was verified. Without it, an upload URL (`/v1/upload/<key>`) only acts on the upload
	 * that an authenticated `POST /v1/upload` created (the `?u=` id of that URL), never on a key of its own.
	 */
	authenticated?: boolean;
	/**
	 * The request is a trusted read (the backend with its own credential, already authorized): private media is
	 * served without a viewer token. Never set it from a `?token=` query: its credential would end up in URLs.
	 */
	trustedRead?: boolean;
	/** The credential is an upload token: `POST /v1/upload` only creates files under its prefix. */
	uploadGrant?: UploadGrant;
}

export interface RequestState {
	/** Prefix of every storage key the request touches (`""` = the bucket root). */
	storagePrefix: string;
	config?: WorkerConfig;
	access?: RequestAccess;
	/**
	 * Bearer the transcode runner uploads its outputs with. `workerSecretAuth()` sets the Worker secret; an auth
	 * plugin of your own can hand the runner a narrower credential.
	 */
	runnerCredential?: string;
	/**
	 * Bearer sent to the request's `callbackUrl` (client webhook of a transcode or captions job). Unset: the runner
	 * credential; `""`: no `Authorization` header.
	 */
	webhookCredential?: string;
	context?: PluginContext;
}

export interface RequestStatePatch extends Partial<Omit<RequestState, "config" | "access" | "context">> {
	config?: Omit<WorkerConfig, "transcode"> & { transcode?: TranscodeConfig };
	access?: RequestAccess;
	context?: PluginContext;
}

/** Context variable that holds the state. */
export const REQUEST_STATE_VARIABLE = "requestState";

// biome-ignore lint/suspicious/noExplicitAny: any app that mounts the Worker (its own bindings and variables)
type AnyContext = Context<any>;

const INITIAL_STATE: RequestState = { storagePrefix: "" };

/** State of the request. Without one set, the bucket root and no rules. */
export function getRequestState(context: AnyContext): RequestState {
	return (context.get(REQUEST_STATE_VARIABLE) as RequestState | undefined) ?? INITIAL_STATE;
}

/** Did an auth plugin verify the request's credential (`access.authenticated`)? */
export function isAuthenticated(context: AnyContext): boolean {
	return getRequestState(context).access?.authenticated === true;
}

function mergeConfig(current: WorkerConfig | undefined, patch: RequestStatePatch["config"]): WorkerConfig | undefined {
	if (!patch) return current;
	const transcode = patch.transcode ? { ...current?.transcode, ...patch.transcode } : current?.transcode;
	return { ...current, ...patch, ...(transcode ? { transcode } : {}) };
}

function mergeRecord<T extends object>(current: T | undefined, patch: T | undefined): T | undefined {
	return patch ? { ...current, ...patch } : current;
}

/**
 * Narrows the state of the request. Top-level fields replace; `config` (and `config.transcode`), `access` and
 * `context` merge field by field.
 */
export function updateRequestState(context: AnyContext, patch: RequestStatePatch): RequestState {
	// A webhook without its scope would be resolved, when queued, to whatever answers for the default one.
	assertWebhookScope(patch.config?.webhooks);
	const current = getRequestState(context);
	const config = mergeConfig(current.config, patch.config);
	const access = mergeRecord(current.access, patch.access);
	const pluginContext = mergeRecord(current.context, patch.context);
	const next: RequestState = {
		...current,
		...patch,
		...(config ? { config } : {}),
		...(access ? { access } : {}),
		...(pluginContext ? { context: pluginContext } : {}),
	};
	context.set(REQUEST_STATE_VARIABLE, next);
	return next;
}
