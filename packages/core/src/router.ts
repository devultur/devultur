import { isBearerOf } from "./bearer";
import { DEFAULT_PRESIGN_EXPIRY_SECONDS } from "./constants";
import { contentDispositionInline, sanitizeFilename } from "./filenames";
import { type DevulturMedia, mediaUrl, publicUrl, resolveVisibility } from "./media";
import type { MediaUrlOptions } from "./media-url";
import { FILE_MIMES, IMAGE_MIMES, isValidMime, VIDEO_MIMES } from "./mime";
import { extractKeyFromUrl, filePath, imagePath, videoRawPath } from "./paths";
import { signUrl, verifySignedUrl } from "./signing";
import { parseSize } from "./size";
import { createStorageClient } from "./storage";
import type {
	CaptionsJobResult,
	CaptionsStatusResult,
	CreateUploadUrlOptions,
	DirectStorageConfig,
	IssueTokenOptions,
	MediaEvent,
	MediaRouter,
	MediaRouterConfig,
	SignOptions,
	StorageClient,
	TokenResult,
	TranscodeJobResult,
	TranscodeOptions,
	TranscodeStatusResult,
	UploadUrlResult,
	WebhookVerifyOptions,
	WorkerConfig,
} from "./types";
import { authenticateWebhook } from "./webhook";
import { createWorkerClient, type WorkerClient } from "./worker-client";

function isDirectStorageConfig(config: MediaRouterConfig): config is DirectStorageConfig {
	return "storage" in config;
}

function isWorkerConfig(config: MediaRouterConfig): config is WorkerConfig {
	return "secret" in config;
}

// Client-side type/size resolution: only the direct storage (BYO) path needs it — it forms the key
// locally. With a worker, the worker infers the type from the content-type and enforces size/mime from its config.
function resolveMediaType(contentType: string, config: DirectStorageConfig): "video" | "image" | "file" | null {
	if (config.video && isValidMime(contentType, config.video.accept ?? VIDEO_MIMES)) return "video";
	if (config.image && isValidMime(contentType, config.image.accept ?? IMAGE_MIMES)) return "image";
	if (config.file && isValidMime(contentType, config.file.accept ?? FILE_MIMES)) return "file";
	return null;
}

function validateFileSize(mediaType: "video" | "image" | "file", config: DirectStorageConfig): void {
	const builderConfig = config[mediaType];
	if (!builderConfig) return;
	parseSize(builderConfig.maxSize);
}

export function createMediaRouter(config: MediaRouterConfig): MediaRouter {
	let storage: StorageClient | null = null;
	let worker: WorkerClient | null = null;

	if (isDirectStorageConfig(config)) {
		storage = createStorageClient(config.storage);
	}

	const deliveryConfig = isDirectStorageConfig(config) ? config.delivery : undefined;
	// Base for delivery URLs: the worker, or BYO's own delivery domain.
	const resolvedBaseUrl = isWorkerConfig(config) ? config.baseUrl : (deliveryConfig?.customDomain ?? "");

	if (isWorkerConfig(config) && config.secret) {
		worker = createWorkerClient(config.secret, config.baseUrl);
	}

	function requireWorker(method: string): WorkerClient {
		if (!worker) throw new Error(`${method} requires a worker (baseUrl + secret).`);
		return worker;
	}

	return {
		config,
		storage,

		video: isDirectStorageConfig(config) ? config.video : undefined,
		image: isDirectStorageConfig(config) ? config.image : undefined,
		file: isDirectStorageConfig(config) ? config.file : undefined,

		async createUploadUrl(options: CreateUploadUrlOptions): Promise<UploadUrlResult> {
			// Worker: infers the type from the content-type and enforces size/mime/visibility from its config → no
			// need to resolve anything client-side. We just pass the options through.
			if (worker) {
				const result = await worker.createUploadUrl(options);
				return { url: result.url, key: result.key, id: result.id, kind: result.kind, visibility: result.visibility };
			}

			// Direct storage (BYO): we form the key locally → so we do resolve type/size/visibility here.
			if (!isDirectStorageConfig(config) || !storage) {
				throw new Error("No storage client or worker client available.");
			}
			// A presigned PUT goes straight to the bucket: nothing would enforce the lock, so refuse instead of ignoring it.
			if (options.lock || options.hold)
				throw new Error("Object lock needs a media worker; direct storage can't enforce it.");

			const mediaType = resolveMediaType(options.contentType, config);
			if (!mediaType) {
				throw new Error(`Unsupported content type: "${options.contentType}"`);
			}
			validateFileSize(mediaType, config);

			const id = crypto.randomUUID();
			const visibility = resolveVisibility(options.visibility, config[mediaType]?.visibility);
			// Parity with the worker's path: sanitize the name for the KEY (names with spaces/accents
			// broke the key/URL and hung the upload), keep the original in Content-Disposition,
			// and send the video raw to Infrequent Access (same rule as `upload.ts`).
			const safeFilename = sanitizeFilename(options.filename);
			const kindPath =
				mediaType === "video"
					? videoRawPath(id, safeFilename)
					: mediaType === "image"
						? imagePath(id, safeFilename)
						: filePath(id, safeFilename);
			const key = `${visibility}/${kindPath}`;

			const url = await storage.createUploadUrl({
				key,
				contentType: options.contentType,
				metadata: options.metadata,
				contentDisposition: contentDispositionInline(options.filename),
				// Note: this path goes through R2's S3 API (`x-amz-storage-class`), NOT the native binding.
				// The worker uses `"InfrequentAccess"` (binding); here the S3-compatible value is `"STANDARD_IA"`.
				...(mediaType === "video" ? { storageClass: "STANDARD_IA" } : {}),
			});

			return { url, key, id, kind: mediaType, visibility };
		},

		async sign(url: string, options?: SignOptions): Promise<string> {
			if (worker) {
				throw new Error("With a worker, use issueToken() to generate short-lived tokens instead of sign().");
			}

			if (!deliveryConfig?.signSecret) {
				throw new Error("Delivery signSecret is required for URL signing.");
			}

			const expiresIn = options?.expiresIn ?? deliveryConfig.urlExpiry ?? DEFAULT_PRESIGN_EXPIRY_SECONDS;
			return signUrl(url, deliveryConfig.signSecret, expiresIn);
		},

		async verify(signedUrl: string): Promise<boolean> {
			if (worker) {
				return true;
			}

			if (!deliveryConfig?.signSecret) {
				throw new Error("Delivery signSecret is required for URL verification.");
			}

			return verifySignedUrl(signedUrl, deliveryConfig.signSecret);
		},

		async handleWebhook(payload: unknown, options: WebhookVerifyOptions): Promise<MediaEvent> {
			// The Worker authenticates its webhooks with `Authorization: Bearer <secret>` (fails closed without a secret).
			if (!isBearerOf(options.authorization ?? null, options.secret)) {
				throw new Error("Unauthorized webhook.");
			}
			const event = typeof payload === "string" ? JSON.parse(payload) : payload;
			return event as MediaEvent;
		},

		verifyWebhook: authenticateWebhook,

		getMediaUrl(media: DevulturMedia, options?: MediaUrlOptions): string {
			if (worker) return worker.getMediaUrl(media, options);
			return mediaUrl(resolvedBaseUrl, media, options);
		},

		publicUrl(media: DevulturMedia<"public">, options?: Omit<MediaUrlOptions, "token">): string {
			return publicUrl(resolvedBaseUrl, media, options);
		},

		extractKey(url: string): string | null {
			if (worker) return worker.extractKey(url);
			return extractKeyFromUrl(url, resolvedBaseUrl);
		},

		async transcode(key: string, options?: TranscodeOptions): Promise<TranscodeJobResult> {
			return requireWorker("transcode").transcode(key, options);
		},

		async getTranscodeStatus(jobId: string): Promise<TranscodeStatusResult> {
			return requireWorker("getTranscodeStatus").getTranscodeStatus(jobId);
		},

		async requestCaptions(key: string, locales: string[]): Promise<CaptionsJobResult> {
			return requireWorker("requestCaptions").requestCaptions(key, locales);
		},

		async getCaptionsStatus(transcriptId: string): Promise<CaptionsStatusResult> {
			return requireWorker("getCaptionsStatus").getCaptionsStatus(transcriptId);
		},

		async issueToken(userId: string, options?: IssueTokenOptions): Promise<TokenResult> {
			return requireWorker("issueToken").issueToken(userId, options);
		},
	};
}
