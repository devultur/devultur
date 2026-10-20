import type { MediaType, ObjectLock, ResolvedLock, SecurityPolicy, TranscodeSpec, Visibility } from "@devultur/core";
import type { UploadGrant } from "./export-types";
import type { PluginHooks } from "./plugin-hooks";
import type { PluginContext, RequestState } from "./request-state";
import type { RouteResult } from "./route-result";
import type { TranscodeContainerNamespace } from "./transcode/cloudflare";

export type { UploadGrant };

export const HashAlgorithm = {
	SHA_256: "SHA-256",
} as const;

export type HashAlgorithm = (typeof HashAlgorithm)[keyof typeof HashAlgorithm];

export const HmacAlgorithm = {
	NAME: "HMAC",
	HASH: HashAlgorithm.SHA_256,
} as const;

export const KeyFormat = {
	RAW: "raw",
} as const;

export type KeyFormat = (typeof KeyFormat)[keyof typeof KeyFormat];

export const JwtAlgorithm = {
	HS256: "HS256",
} as const;

export const JwtType = {
	JWT: "JWT",
} as const;

export interface WorkerEnv {
	MEDIA_BUCKET: R2Bucket;
	// Bucket dedicated to L4 encryption material (separate from media, dev/prod). Only touched when a
	// resource is encrypted (`encrypt`); optional for self-hosts that don't use encryption. With `encrypt` on and no
	// bucket, private writes fail closed (`503 keys_bucket_missing`, see keys-bucket.ts).
	KEYS_BUCKET?: R2Bucket;
	MEDIA_KV: KVNamespace;
	DELIVERY_SIGN_SECRET: string;
	// Transcode runner (`fly` | `cloudflare` | `http`; empty = `cloudflare`). See transcode/runner.ts.
	TRANSCODE_RUNNER?: string;
	// `fly` runner: only required when that's the runner picked.
	FLY_API_TOKEN?: string;
	FLY_APP_NAME?: string;
	FLY_TRANSCODE_IMAGE?: string;
	// Region of the Fly machine (`iad`, `gru`, …; optional). Absent → Fly picks the region. Var, not a secret.
	FLY_REGION?: string;
	// Size of the Fly transcode machine (optional; default `performance` 4 vCPU / 8192 MB, see
	// transcode/fly.ts). Vars, not secrets: `[vars]` in wrangler.toml.
	FLY_TRANSCODE_CPU_KIND?: string;
	FLY_TRANSCODE_CPUS?: string;
	FLY_TRANSCODE_MEMORY_MB?: string;
	// `cloudflare` runner: binding of the `TranscodeContainer` Durable Object (Cloudflare Containers) and
	// instance size (`standard-4` by default). See transcode/cloudflare.ts.
	TRANSCODE_CONTAINER?: TranscodeContainerNamespace;
	CF_TRANSCODE_INSTANCE?: string;
	// `http` runner: endpoint that receives the job (VPS, own queue) + shared bearer. See transcode/http.ts.
	TRANSCODE_RUNNER_URL?: string;
	TRANSCODE_RUNNER_SECRET?: string;
	TRANSCODE_RUNNER_CPUS?: string;
	GROQ_API_KEY: string;
	MISTRAL_API_KEY: string;
	// Bearer that the backend sends on control routes (`createWorker()` default auth, see worker-auth.ts). The
	// transcode runner also uploads its outputs with it. Without it those routes answer 503.
	WORKER_AUTH_SECRET?: string;
	// Secret shared by the Worker and the transcode runner. The Worker injects it into the runner env and the
	// script sends it on every callback. `/v1/webhooks/transcode` requires it (503 when unset), so nobody with a
	// videoId can forge transcode events. See webhooks.ts.
	TRANSCODE_WEBHOOK_SECRET?: string;
	// Durable Object of the one-time-use download links (`DownloadLink`, see download-link.ts). Without the
	// binding `POST /v1/token/download` answers 501.
	DOWNLOAD_LINKS?: DurableObjectNamespace;
	// Who does the image transforms. Empty/`worker` (default) = WASM codecs in the Worker + variant in R2,
	// with Cloudflare Images as a fallback; `cloudflare` = kill switch, everything goes to `cf.image` like before.
	IMAGE_TRANSFORMS?: string;
	// Megapixel cap the Worker decodes (default 4, image/transform-plan.ts). Above it → mezzanine.
	IMAGE_TRANSFORMS_MAX_MEGAPIXELS?: string;
}

// Cap of the adaptive HLS ladder: up to what resolution the transcode engine generates renditions.
// It's an encoding parameter of the engine; it's set in the scope's `config.transcode.maxResolution` or
// derived from the preset if absent. The policy of which cap to apply lives in the config.
export const MaxResolution = {
	P720: "720p",
	P1080: "1080p",
	P4K: "4k",
} as const;

export type MaxResolution = (typeof MaxResolution)[keyof typeof MaxResolution];

// Upload rule per media type. Set by the config (e.g. the Worker's config or a plugin).
// `maxSizeBytes` arrives already resolved (a plugin can combine it with its own caps); the route only
// enforces it. `accept` is the content-type whitelist (exact or `type/*`); empty/absent = everything.
// `visibility` is the config's default visibility for this type (the per-upload override wins; absent
// → `private`, secure-default).
export interface UploadTypeRule {
	maxSizeBytes?: number;
	accept?: string[];
	visibility?: Visibility;
}

export interface UploadRules {
	video?: UploadTypeRule;
	image?: UploadTypeRule;
	file?: UploadTypeRule;
}

/** R2 storage classes the worker uses for the video raw. */
export type RawStorageClass = "Standard" | "InfrequentAccess";

export interface WorkerVariables {
	/** Request state (storage prefix, rules, access, credentials, plugin context): see request-state.ts. */
	requestState?: RequestState;
	/** Hooks of the plugins (plugin-hooks.ts). */
	pluginHooks?: PluginHooks;
	/** What the route did (route-result.ts). */
	routeResult?: RouteResult;
}

export type WorkerApp = {
	Bindings: WorkerEnv;
	Variables: WorkerVariables;
};

export interface FlyMachine {
	id: string;
	state: string;
}

export interface TranscodeJobMeta {
	videoId: string;
	inputKey: string;
	outputPrefix: string;
	thumbnailKey: string;
	preset: string;
	runner?: string;
}

export interface TranscodeDurationMeta {
	duration: number;
}

export interface GroqTranscriptSegment {
	start: number;
	end: number;
	text: string;
}

export interface GroqTranscriptWord {
	word: string;
	start: number;
	end: number;
}

export interface GroqTranscriptResponse {
	task: string;
	language: string;
	duration: number;
	text: string;
	segments: GroqTranscriptSegment[];
	words: GroqTranscriptWord[];
}

export interface CaptionJobMeta {
	videoId: string;
	/** Locales REQUESTED in the job. */
	locales: string[];
	/** Locales actually generated (source + duplicates + successful translations). May be a subset of `locales`. */
	completedLocales?: string[];
	status: "completed" | "failed";
	error?: string;
}

export interface UploadRequest {
	filename: string;
	contentType: string;
	mediaType?: MediaType;
	metadata?: Record<string, string>;
	/** Visibility resolved by the client (upload override → router default). Omitted → `private`. */
	visibility?: Visibility;
	/** Intrinsic dimensions (captured client-side for images) → travel back in the reference. */
	width?: number;
	height?: number;
	/** Per-resource security override (binding/encrypt). Resolved against the config default. */
	security?: SecurityPolicy;
	/** Path chosen by the client inside `asset/` → key `{visibility}/asset/{path}` (see core/assets.ts). */
	path?: string;
	/** Replace an existing asset (default false → 409). Only with `path`. */
	overwrite?: boolean;
	/** sha256 hex of the file: the PUT verifies it (400 on mismatch); multipart stores it as declared. */
	sha256?: string;
	/** File TTL in seconds: it only gets deleted once it expires (410 from then on). */
	expiresIn?: number;
	/** Declared size (bytes): early rejection (413) against the cap before uploading. */
	size?: number;
	/** `Cache-Control` of an asset: preset (`immutable` | `revalidate` | `no-cache`) or a validated string. */
	cacheControl?: string;
	/** Lock of the new file (retention and/or hold). Resolved against the token's minimum and the config default. */
	lock?: ObjectLock;
	/** Shorthand for `lock.hold`: retain the file indefinitely from the moment it exists. */
	hold?: boolean;
}

export interface UploadPending {
	contentType: string;
	storageKey: string;
	/** Key of the upload URL the pending was issued for: its id only works on that URL. */
	key?: string;
	originalFilename?: string;
	/** Per-resource security override, resolved against the config default in the PUT. */
	security?: SecurityPolicy;
	/** Effective max size (resolved in the POST, where the config is in context) → the PUT enforces it
	 *  against the real content-length, since it carries no credential. */
	maxSizeBytes?: number;
	/** Plugin context of the POST: the credential-less PUT carries nothing else that tells who created it. */
	context?: PluginContext;
	/** Storage class of the video raw (resolved in the POST with the config in context). Absent = Standard. */
	storageClass?: RawStorageClass;
	/** Multipart upload in progress (added by `?multipart=create`; the parts and the complete require it). */
	multipart?: MultipartPending;
	/** sha256 declared when the upload was created (hex). */
	sha256?: string;
	/** File expiration (epoch ms) → `customMetadata.expiresAt` and the media row. */
	expiresAt?: number;
	/** Asset with `overwrite: true` (otherwise the PUT is conditional: 409 if it already exists). */
	overwrite?: boolean;
	/** Key in the `asset/` namespace (client path): without `overwrite` the PUT won't clobber an existing object. */
	isAsset?: boolean;
	/** `Cache-Control` resolved in the POST → the object's `httpMetadata.cacheControl`. */
	cacheControl?: string;
	/** `config.uploadMetadata` of the POST → the object's `customMetadata` (under the Worker's own). */
	uploadMetadata?: Record<string, string>;
	/** Lock resolved in the POST → the object's `customMetadata.lock`, in the same write as its bytes. */
	lock?: ResolvedLock;
}

export interface MultipartPending {
	uploadId: string;
	/** Declared total size: each part must measure exactly its share → the total can't exceed it. */
	size: number;
	partSize: number;
	/** Encryption envelope (`enc`) if the object is encrypted: each part is encrypted with its offset's counter. */
	enc?: string;
	/** sha256 of the whole file declared at create: each part must carry its own (`x-devultur-sha256`). */
	sha256?: string;
}

export interface TranscodeRequest {
	key: string;
	/** Name (config preset, template, or `hls-*` alias) or inline spec. Omitted → config default. */
	preset?: string | TranscodeSpec;
	callbackUrl?: string;
}

export interface CaptionsRequest {
	key: string;
	locales: string[];
	callbackUrl?: string;
}

export interface TokenRequest {
	userId: string;
	scopes?: string[];
	expiresIn?: number;
	/** Session secret generated by the client → binds the token to the browser session (session binding). */
	sessionSecret?: string;
}

export interface MistralChatResponse {
	choices: [{ message: { content: string } }];
}
