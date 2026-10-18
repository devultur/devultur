import { DevulturApiError, errorFromResponse } from "./api-error";
import type { CaptionStatus, TranscodePreset, TranscodeStatus } from "./constants";
import { type DevulturMedia, mediaUrl, type Visibility } from "./media";
import type { MediaUrlOptions } from "./media-url";
import { uploadToCapabilityUrl } from "./multipart";
import { extractKeyFromUrl } from "./paths";
import type { TranscodeSpec } from "./transcode-spec";
import type { CreateUploadUrlOptions, UploadUrlResult } from "./types";
import { type AssetsClient, createAssetsClient } from "./worker-assets";
import { createFilesClient, createUploadsClient, type FilesClient, type UploadsClient } from "./worker-exports";

export { DevulturApiError };

// HTTP client of a media worker (`createWorker()` from @devultur/self-host or compatible): Bearer credential + base URL.

export interface WorkerClient {
	uploadFile(file: File, options?: { metadata?: Record<string, string> }): Promise<UploadFileResult>;
	createUploadUrl(options: CreateUploadUrlOptions): Promise<WorkerUploadResult>;
	getMediaUrl(media: DevulturMedia, options?: MediaUrlOptions): string;
	extractKey(url: string): string | null;
	delete(key: string): Promise<void>;
	deleteVideo(videoId: string, visibility?: Visibility): Promise<DeleteVideoResult>;
	transcode(key: string, options?: TranscodeOptions): Promise<TranscodeJobResult>;
	getTranscodeStatus(jobId: string): Promise<TranscodeStatusResult>;
	requestCaptions(key: string, locales: string[], options?: { callbackUrl?: string }): Promise<CaptionsJobResult>;
	getCaptionsStatus(transcriptId: string): Promise<CaptionsStatusResult>;
	issueToken(userId: string, options?: IssueTokenOptions): Promise<TokenResult>;
	/** Upload tokens scoped to a prefix, and uploads to `asset/{path}` (exports from CI). */
	uploads: UploadsClient;
	/** `head` (size/sha256), single-use download links, streaming and deleting files. */
	files: FilesClient;
	/** Paginated listing of the `asset/` namespace. */
	assets: AssetsClient;
}

export interface UploadFileResult {
	key: string;
	id: string;
	url: string;
	size: number;
}

export interface WorkerUploadResult extends UploadUrlResult {
	uploadUrl: string;
}

export interface DeleteVideoResult {
	videoId: string;
	deletedCount: number;
}

export interface TranscodeOptions {
	/**
	 * Omitted → the config's default preset (if the worker publishes one). A name resolves first against config presets,
	 * then templates (`web-adaptive`, `hero`, `social-vertical`) and the `hls-*` aliases. It also accepts an
	 * inline `TranscodeSpec`, which the worker validates strictly.
	 */
	preset?: TranscodePreset | (string & {}) | TranscodeSpec;
	callbackUrl?: string;
}

export interface TranscodeJobResult {
	jobId: string;
	inputKey: string;
	outputPrefix: string;
	thumbnailKey: string;
	preset: string;
	status: string;
}

export interface TranscodeStatusResult {
	jobId: string;
	status: TranscodeStatus;
	duration?: number | null;
	playlistUrl?: string | null;
	thumbnailKey?: string | null;
	/** Only with `status: "failed"`: message, category and whether retrying is advisable (from `transcode.failed`). */
	error?: string;
	reason?: string;
	retriable?: boolean;
}

export interface CaptionsJobResult {
	transcriptId: string;
	transcriptIds?: Record<string, string>;
	inputKey: string;
	locales: string[];
	status: string;
}

export interface CaptionsStatusResult {
	transcriptId: string;
	status: CaptionStatus;
	completedLocales?: string[];
	error?: string;
}

export interface IssueTokenOptions {
	scopes?: string[];
	expiresIn?: number;
	/** Client's session secret → ties the token to the browser session (sent in the header on delivery). */
	sessionSecret?: string;
}

export interface TokenResult {
	token: string;
	expiresIn: number;
	expiresAt: number;
}

export type FetchApi = (path: string, init?: RequestInit) => Promise<Response>;
export type JsonRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

/** Client transport: authenticated `fetch` against `baseUrl` that throws `DevulturApiError` on a non-2xx. */
export interface WorkerTransport {
	fetchApi: FetchApi;
	request: JsonRequest;
	requestVoid(path: string, init?: RequestInit): Promise<void>;
}

export function createWorkerTransport(credential: string, baseUrl: string): WorkerTransport {
	async function fetchApi(path: string, options: RequestInit = {}): Promise<Response> {
		const response = await fetch(`${baseUrl}${path}`, {
			...options,
			headers: {
				Authorization: `Bearer ${credential}`,
				...options.headers,
			},
		});

		if (!response.ok) {
			throw await errorFromResponse(response);
		}

		return response;
	}

	async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
		const response = await fetchApi(path, {
			...options,
			headers: { "Content-Type": "application/json", ...options.headers },
		});
		return response.json() as Promise<T>;
	}

	async function requestVoid(path: string, options: RequestInit = {}): Promise<void> {
		await fetchApi(path, options);
	}

	return { fetchApi, request, requestVoid };
}

/** Client for a media worker. `credential` travels as Bearer; `baseUrl` is the worker's origin. */
export function createWorkerClient(credential: string, baseUrl: string): WorkerClient {
	const base = baseUrl;
	const { fetchApi, request, requestVoid } = createWorkerTransport(credential, base);

	return {
		uploads: createUploadsClient(base, request),
		files: createFilesClient(fetchApi, request),
		assets: createAssetsClient(request),

		async uploadFile(file: File, options?: { metadata?: Record<string, string> }): Promise<UploadFileResult> {
			const result = await request<WorkerUploadResult>("/v1/upload", {
				method: "POST",
				body: JSON.stringify({
					filename: file.name,
					contentType: file.type,
					metadata: options?.metadata,
				}),
			});

			// Large files go in parts (the worker limits the body per request); the rest, a single PUT.
			await uploadToCapabilityUrl(`${base}${result.uploadUrl}`, file);

			return {
				key: result.key,
				id: result.id,
				url: `${base}/v1/media/${result.key}`,
				size: file.size,
			};
		},

		async createUploadUrl(options: CreateUploadUrlOptions): Promise<WorkerUploadResult> {
			const result = await request<WorkerUploadResult>("/v1/upload", {
				method: "POST",
				body: JSON.stringify({
					filename: options.filename,
					contentType: options.contentType,
					metadata: options.metadata,
					visibility: options.visibility,
				}),
			});

			return {
				url: `${base}${result.uploadUrl}`,
				uploadUrl: `${base}${result.uploadUrl}`,
				key: result.key,
				id: result.id,
				kind: result.kind,
				visibility: result.visibility,
			};
		},

		getMediaUrl(media: DevulturMedia, options?: MediaUrlOptions): string {
			return mediaUrl(base, media, options);
		},

		extractKey(url: string): string | null {
			return extractKeyFromUrl(url, base);
		},

		async delete(key: string): Promise<void> {
			await requestVoid(`/v1/media/${key}`, { method: "DELETE" });
		},

		async deleteVideo(videoId: string, visibility?: Visibility): Promise<DeleteVideoResult> {
			// Visibility scopes the exact folder prefix (`{visibility}/video/{id}/`); without it the
			// worker sweeps both prefixes. It comes from the reference, so we pass it when we have it.
			const query = visibility ? `?visibility=${visibility}` : "";
			return request<DeleteVideoResult>(`/v1/media/videos/${videoId}${query}`, { method: "DELETE" });
		},

		async transcode(key: string, options?: TranscodeOptions): Promise<TranscodeJobResult> {
			return request<TranscodeJobResult>("/v1/transcode", {
				method: "POST",
				body: JSON.stringify({
					key,
					preset: options?.preset,
					callbackUrl: options?.callbackUrl,
				}),
			});
		},

		async getTranscodeStatus(jobId: string): Promise<TranscodeStatusResult> {
			return request<TranscodeStatusResult>(`/v1/transcode/${jobId}`);
		},

		async requestCaptions(
			key: string,
			locales: string[],
			options?: { callbackUrl?: string },
		): Promise<CaptionsJobResult> {
			return request<CaptionsJobResult>("/v1/captions", {
				method: "POST",
				body: JSON.stringify({ key, locales, callbackUrl: options?.callbackUrl }),
			});
		},

		async getCaptionsStatus(transcriptId: string): Promise<CaptionsStatusResult> {
			return request<CaptionsStatusResult>(`/v1/captions/${transcriptId}`);
		},

		async issueToken(userId: string, options?: IssueTokenOptions): Promise<TokenResult> {
			return request<TokenResult>("/v1/token", {
				method: "POST",
				body: JSON.stringify({
					userId,
					scopes: options?.scopes,
					expiresIn: options?.expiresIn,
					sessionSecret: options?.sessionSecret,
				}),
			});
		},
	};
}
