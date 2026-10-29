import type { WebhookEvent } from "./lifecycle-events";
import type { ObjectLock } from "./lock";
import type { DevulturMedia, Visibility } from "./media";
import type { MediaUrlOptions, PosterUrls } from "./media-url";
import type { WebhookSecret } from "./webhook-signature";
import type {
	CaptionsJobResult,
	CaptionsStatusResult,
	IssueTokenOptions,
	TokenResult,
	TranscodeJobResult,
	TranscodeOptions,
	TranscodeStatusResult,
} from "./worker-client";

/** An output of a transcode: a framing's HLS ladder or a standalone MP4. `url` is stable (no token). */
export interface TranscodeRendition {
	/** Framing: `main` (the root spec) or a variant's name (e.g. `vertical`). */
	variant: string;
	kind: "hls" | "mp4";
	/** Generated rung (`360p`…`4k`); for HLS, the highest in the ladder. */
	rung: string;
	/** Virtual key (`{visibility}/video/{id}/…`). */
	key: string;
	/** Actual size in pixels (for HLS, that of the highest rung). Absent if the runner couldn't measure it. */
	width?: number;
	height?: number;
	url: string;
}

export type {
	CaptionsJobResult,
	CaptionsStatusResult,
	IssueTokenOptions,
	TokenResult,
	TranscodeJobResult,
	TranscodeOptions,
	TranscodeStatusResult,
};

// Worker = just a credential + endpoint of a media worker (`createWorker()` from @devultur/self-host). ALL the
// policy (size/mime/visibility per type, locales, L3/L4 security) belongs to the worker: it's the one enforcing it. There's no
// builder-config (`video`/`image`/`file`) here because it would be dead config the worker ignores/overrides (the type is
// inferred from the content-type).
export interface WorkerConfig {
	/** Origin of the worker (`https://media.example.com`). */
	baseUrl: string;
	/** Credential sent as Bearer (the worker's `WORKER_AUTH_SECRET`). */
	secret: string;
}

// Direct storage (BYO: pre-signed R2 directly, no worker): the config is client-side — it forms the keys and resolves
// type/visibility in the caller's own process. No transcode or captions (the worker does that, see `WorkerConfig`).
export interface DirectStorageConfig {
	storage: StorageConfig;
	delivery?: DeliveryConfig;
	video?: VideoBuilderConfig;
	image?: ImageBuilderConfig;
	file?: FileBuilderConfig;
}

export type MediaRouterConfig = WorkerConfig | DirectStorageConfig;

export interface StorageConfig {
	provider: "r2";
	bucket: string;
	accountId: string;
	accessKeyId: string;
	secretAccessKey: string;
	buckets?: { video?: string; image?: string; file?: string };
}

export interface DeliveryConfig {
	signSecret: string;
	urlExpiry?: number;
	customDomain?: string;
}

export interface VideoBuilderConfig {
	maxSize: string | number;
	accept?: string[];
	/** Visibilidad default de este tipo. Omitido → `private` (secure-by-default). Override por upload. */
	visibility?: Visibility;
}

export interface ImageBuilderConfig {
	maxSize: string | number;
	accept?: string[];
	/** Visibilidad default de este tipo. Omitido → `private` (secure-by-default). Override por upload. */
	visibility?: Visibility;
}

export interface FileBuilderConfig {
	maxSize: string | number;
	accept?: string[];
	/** Visibilidad default de este tipo. Omitido → `private` (secure-by-default). Override por upload. */
	visibility?: Visibility;
}

export interface CreateUploadUrlOptions {
	filename: string;
	contentType: string;
	metadata?: Record<string, string>;
	/** Visibility override for this resource. Omitted → inherits the router's default per type. */
	visibility?: Visibility;
	/** Intrinsic dimensions (captured client-side for images) → carried into the reference. */
	width?: number;
	height?: number;
	/** Lock of the new file (retention and/or hold), written with its bytes. Needs a media worker. */
	lock?: ObjectLock;
	/** Shorthand for `lock.hold`: retain the file indefinitely from the moment it exists. */
	hold?: boolean;
}

export interface UploadUrlResult {
	url: string;
	key: string;
	id: string;
	/** Resolved type of the resource — part of the `DevulturMedia` the client assembles after the PUT. */
	kind?: DevulturMedia["kind"];
	/** Resolved effective visibility (upload override → router default → private). */
	visibility?: Visibility;
}

export interface SignOptions {
	expiresIn?: number;
}

/** How {@link MediaRouter.handleWebhook} authenticates a webhook from the media Worker. */
export interface WebhookVerifyOptions {
	/** The request's `Authorization` header. The Worker sends `Bearer <secret>`. */
	authorization: string | null | undefined;
	/** The secret the Worker sends: the one your backend uses as the Worker credential. */
	secret: string;
}

/**
 * How {@link MediaRouter.verifyWebhook} authenticates a webhook from the media Worker: a signed one (`webhook-*`
 * headers, verified with `signingSecret`) or one with `Authorization: Bearer <secret>`.
 */
export interface SignedWebhookVerifyOptions {
	/** The request's `Authorization` header. Read from `headers` when omitted. */
	authorization?: string | null;
	/** The bearer secret of a job's `callbackUrl` (the Worker credential). Unset: bearer requests are refused. */
	secret?: string;
	/**
	 * The Worker's webhook signing secret (`webhooks.secret` / `MEDIA_WEBHOOK_SECRET`); several during a rotation. A
	 * request carrying a `webhook-signature` is verified with it, and the payload must be the raw body (a string).
	 */
	signingSecret?: WebhookSecret;
	/** The request's headers: the `webhook-*` ones are read from them. */
	headers?: Headers | Record<string, string | null | undefined>;
	/** How far, in seconds, the `webhook-timestamp` may be from now. Default 300. */
	toleranceSeconds?: number;
}

export const MediaStatus = {
	IDLE: "idle",
	QUEUED: "queued",
	TRANSCODING: "transcoding",
	CAPTIONING: "captioning",
	READY: "ready",
	FAILED: "failed",
} as const;

export type MediaStatusValue = (typeof MediaStatus)[keyof typeof MediaStatus];

export const MediaEventName = {
	TRANSCODE_STARTED: "transcode.started",
	TRANSCODE_PROGRESS: "transcode.progress",
	TRANSCODE_COMPLETE: "transcode.complete",
	TRANSCODE_FAILED: "transcode.failed",
	CAPTIONS_COMPLETE: "captions.complete",
	CAPTIONS_FAILED: "captions.failed",
} as const;

export type MediaEventNameValue = (typeof MediaEventName)[keyof typeof MediaEventName];

export type MediaEventType =
	| "transcode.started"
	| "transcode.progress"
	| "transcode.complete"
	| "transcode.failed"
	| "captions.complete"
	| "captions.failed";

// Categorized reason for a processing failure — lets you decide the user-facing message and whether the
// job is retryable, instead of parsing a free-form string. `retriable` travels separately in the event/status.
export type FailureReason = "invalid_input" | "unsupported_codec" | "timeout" | "capacity" | "internal";

// Pipeline step within the "processing" phase (for typed progress, no `as any`).
export type ProcessingPhase = "downloading" | "encoding" | "uploading" | "captioning";

export type MediaEvent =
	| { event: "transcode.started"; videoId: string; totalSegments: number; duration: number }
	| {
			event: "transcode.progress";
			videoId: string;
			currentSegment: number;
			totalSegments: number;
			phase: ProcessingPhase;
	  }
	| {
			event: "transcode.complete";
			videoId: string;
			duration: number;
			playlistKey: string;
			thumbnailKey: string;
			/** Only with a config preset or an inline spec: each output with its stable URL. */
			renditions?: TranscodeRendition[];
			posterUrls?: Partial<PosterUrls>;
			hasAudio?: boolean;
			/**
			 * Storyboard key (`{visibility}/video/{id}/storyboard/storyboard.vtt`); URL via `buildStoryboardUrl`.
			 * Same rule as `renditions`: only with config presets, templates, or inline specs.
			 */
			storyboardKey?: string;
	  }
	| { event: "transcode.failed"; videoId: string; error: string; reason?: FailureReason; retriable?: boolean }
	| { event: "captions.complete"; videoId: string; locales: string[] }
	| { event: "captions.failed"; videoId: string; error: string; reason?: FailureReason; retriable?: boolean };

export interface StorageClient {
	createUploadUrl(options: {
		key: string;
		contentType: string;
		metadata?: Record<string, string>;
		expiresIn?: number;
		/** Storage class (e.g. Infrequent Access for the video raw). Signed into the PUT. */
		storageClass?: string;
		/** `Content-Disposition` to store on the object (original name for display/download). */
		contentDisposition?: string;
	}): Promise<string>;
	createDownloadUrl(options: { key: string; expiresIn?: number }): Promise<string>;
	deleteObject(key: string): Promise<void>;
	headObject(key: string): Promise<{ size: number; contentType: string; lastModified: Date } | null>;
}

export interface MediaRouter {
	config: MediaRouterConfig;
	storage: StorageClient | null;
	createUploadUrl(options: CreateUploadUrlOptions): Promise<UploadUrlResult>;
	sign(url: string, options?: SignOptions): Promise<string>;
	verify(signedUrl: string): Promise<boolean>;
	/** Authenticates a webhook from the media Worker and returns its event. Throws when it isn't authorized. */
	handleWebhook(payload: unknown, options: WebhookVerifyOptions): Promise<MediaEvent>;
	/**
	 * Like `handleWebhook`, for an endpoint that also takes the Worker's signed media webhooks: a signed request
	 * returns its envelope ({@link WebhookEvent}), a bearer one the bare event. Throws a `WebhookAuthError`.
	 */
	verifyWebhook(payload: unknown, options: SignedWebhookVerifyOptions): Promise<MediaEvent | WebhookEvent>;
	/** Delivery URL from a typed reference. Token-transparent (public omits the token). */
	getMediaUrl(media: DevulturMedia, options?: MediaUrlOptions): string;
	/** Stable public URL — only accepts public media (compile-time guard against leaking private). */
	publicUrl(media: DevulturMedia<"public">, options?: Omit<MediaUrlOptions, "token">): string;
	extractKey(url: string): string | null;
	transcode(key: string, options?: TranscodeOptions): Promise<TranscodeJobResult>;
	getTranscodeStatus(jobId: string): Promise<TranscodeStatusResult>;
	requestCaptions(key: string, locales: string[]): Promise<CaptionsJobResult>;
	getCaptionsStatus(transcriptId: string): Promise<CaptionsStatusResult>;
	issueToken(userId: string, options?: IssueTokenOptions): Promise<TokenResult>;
	video: VideoBuilderConfig | undefined;
	image: ImageBuilderConfig | undefined;
	file: FileBuilderConfig | undefined;
}
