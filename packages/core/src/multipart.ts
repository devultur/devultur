// Multipart upload against the worker's capability URL (`…/v1/upload/<key>`). A Worker limits each
// request's body (~100 MB), so above MULTIPART_THRESHOLD_BYTES the file is uploaded in
// MULTIPART_PART_SIZE_BYTES parts over the SAME URL (S3-style protocol via query):
//   POST   ?multipart=create            { size }                → { uploadId, partSize, partCount }
//   PUT    ?uploadId=…&partNumber=N     <part bytes>            → { partNumber, etag }
//   POST   ?multipart=complete          { uploadId, parts }     → { key, size }
//   DELETE ?uploadId=…                                          → aborts
// The URL remains the authenticated POST /v1/upload capability: no call carries a credential.
import { DevulturApiError, errorFromResponse } from "./api-error";
import { SHA256_HEADER, sha256Hex } from "./integrity";

/**
 * Size of each part (the last may be smaller). Multiple of 16 → AES-CTR encryption aligns per part. The
 * worker buffers the part (and its ciphertext if encrypted): 16 MiB keeps the worst case per request around
 * ~32 MiB, well under an isolate's 128 MB even with several concurrent parts.
 */
export const MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
/** Above this (and only against the worker) the upload goes in parts; below, a single PUT. */
export const MULTIPART_THRESHOLD_BYTES = 90 * 1024 * 1024;
/** Parts in flight at a time per upload. */
const PART_CONCURRENCY = 2;

export const MultipartAction = {
	CREATE: "create",
	COMPLETE: "complete",
} as const;

export type MultipartAction = (typeof MultipartAction)[keyof typeof MultipartAction];

export const MULTIPART_QUERY = { ACTION: "multipart", UPLOAD_ID: "uploadId", PART_NUMBER: "partNumber" } as const;

/** What a request against the `/v1/upload/<key>` capability URL is. `INVALID` = incomplete multipart params. */
export const UploadRequestKind = {
	SINGLE: "single",
	MULTIPART_CREATE: "multipart_create",
	MULTIPART_PART: "multipart_part",
	MULTIPART_COMPLETE: "multipart_complete",
	MULTIPART_ABORT: "multipart_abort",
	INVALID: "invalid",
} as const;

export type UploadRequestKind = (typeof UploadRequestKind)[keyof typeof UploadRequestKind];

/**
 * Classifies a request against `/v1/upload/<key>` by method + query. The SINGLE source of truth for the worker
 * (which decides which route runs) and any layer that embeds it and needs the same classification: if they
 * disagreed, a request could write as a single PUT without going through the single-PUT checks. `null` = not a
 * capability request (e.g. a POST without `multipart`). An empty `uploadId` or missing `partNumber` is `INVALID`
 * (400), never a single PUT. Pure.
 */
export function classifyUploadRequest(method: string, searchParams: URLSearchParams): UploadRequestKind | null {
	const uploadId = searchParams.get(MULTIPART_QUERY.UPLOAD_ID);
	const partNumber = searchParams.get(MULTIPART_QUERY.PART_NUMBER);
	if (method === "PUT") {
		if (uploadId === null && partNumber === null) return UploadRequestKind.SINGLE;
		return uploadId && partNumber ? UploadRequestKind.MULTIPART_PART : UploadRequestKind.INVALID;
	}
	if (method === "DELETE") return uploadId ? UploadRequestKind.MULTIPART_ABORT : UploadRequestKind.INVALID;
	if (method !== "POST") return null;
	const action = searchParams.get(MULTIPART_QUERY.ACTION);
	if (action === null) return null;
	if (action === MultipartAction.CREATE) return UploadRequestKind.MULTIPART_CREATE;
	if (action === MultipartAction.COMPLETE) return UploadRequestKind.MULTIPART_COMPLETE;
	return UploadRequestKind.INVALID;
}

export interface MultipartSession {
	uploadId: string;
	partSize: number;
	partCount: number;
}

export interface MultipartPart {
	partNumber: number;
	etag: string;
}

/** Number of parts for `size` bytes. Pure → testable. */
export function multipartPartCount(size: number, partSize: number): number {
	return Math.max(1, Math.ceil(size / partSize));
}

/** `[start, end)` range of part `partNumber` (1-based). Pure → testable. */
export function multipartPartRange(partNumber: number, size: number, partSize: number): { start: number; end: number } {
	const start = (partNumber - 1) * partSize;
	return { start, end: Math.min(start + partSize, size) };
}

function withQuery(uploadUrl: string, params: Record<string, string>): string {
	const url = new URL(uploadUrl);
	for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
	return url.toString();
}

export function multipartCreateUrl(uploadUrl: string): string {
	return withQuery(uploadUrl, { [MULTIPART_QUERY.ACTION]: MultipartAction.CREATE });
}

export function multipartCompleteUrl(uploadUrl: string): string {
	return withQuery(uploadUrl, { [MULTIPART_QUERY.ACTION]: MultipartAction.COMPLETE });
}

export function multipartPartUrl(uploadUrl: string, uploadId: string, partNumber: number): string {
	return withQuery(uploadUrl, {
		[MULTIPART_QUERY.UPLOAD_ID]: uploadId,
		[MULTIPART_QUERY.PART_NUMBER]: String(partNumber),
	});
}

export function multipartAbortUrl(uploadUrl: string, uploadId: string): string {
	return withQuery(uploadUrl, { [MULTIPART_QUERY.UPLOAD_ID]: uploadId });
}

/**
 * Is the URL a devultur worker capability (`/v1/upload/<key>`) and not a pre-signed R2/S3 URL? Only
 * the worker understands the multipart protocol; a pre-signed URL goes straight to R2 (without the ~100 MB limit).
 */
export function isWorkerUploadUrl(uploadUrl: string): boolean {
	try {
		const url = new URL(uploadUrl);
		return url.pathname.includes("/v1/upload/") && !url.searchParams.has("X-Amz-Signature");
	} catch {
		return false;
	}
}

export function shouldUseMultipart(uploadUrl: string, size: number): boolean {
	return size > MULTIPART_THRESHOLD_BYTES && isWorkerUploadUrl(uploadUrl);
}

/** Uploads ONE part and returns its etag. `onProgress` receives the bytes already sent for THIS part. */
export type PartUploader = (
	url: string,
	part: Blob,
	options: { onProgress: (loadedBytes: number) => void; signal?: AbortSignal; sha256?: string },
) => Promise<MultipartPart>;

export interface MultipartUploadOptions {
	/** Total progress (0-100). */
	onProgress?: (percent: number) => void;
	signal?: AbortSignal;
	/** Transport for each part (the browser binding uses XHR to report progress). Default: fetch. */
	uploadPart?: PartUploader;
	/** sha256 (hex) of the full file, declared on create: the worker stores it and returns it in `head`. */
	sha256?: string;
	/** Send each part's sha256 (`x-devultur-sha256`): the worker rejects it if it doesn't match. Required with `sha256`. */
	checksumParts?: boolean;
	/** Parts in flight at a time. Default 2 (browser); a CI runner can handle more. */
	concurrency?: number;
}

export interface CapabilityUploadResult {
	key: string;
	size: number;
}

const fetchPartUploader: PartUploader = async (url, part, options) => {
	const headers: Record<string, string> = options.sha256 ? { [SHA256_HEADER]: options.sha256 } : {};
	const response = await fetch(url, { method: "PUT", body: part, headers, signal: options.signal });
	if (!response.ok) throw await errorFromResponse(response);
	options.onProgress(part.size);
	return (await response.json()) as MultipartPart;
};

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (!response.ok) throw await errorFromResponse(response);
	return (await response.json()) as T;
}

async function uploadParts(
	uploadUrl: string,
	file: Blob,
	session: MultipartSession,
	options: MultipartUploadOptions,
): Promise<MultipartPart[]> {
	const uploadPart = options.uploadPart ?? fetchPartUploader;
	const loadedByPart = new Map<number, number>();
	const reportProgress = () => {
		const loadedBytes = [...loadedByPart.values()].reduce((total, loaded) => total + loaded, 0);
		options.onProgress?.(Math.min(99, Math.floor((loadedBytes / file.size) * 100)));
	};

	const parts: MultipartPart[] = [];
	let nextPartNumber = 1;
	// On the first failure no lane takes on new parts (the upload is going to abort anyway).
	let hasFailed = false;
	const runLane = async () => {
		while (!hasFailed && nextPartNumber <= session.partCount) {
			const partNumber = nextPartNumber++;
			const { start, end } = multipartPartRange(partNumber, file.size, session.partSize);
			const partBlob = file.slice(start, end);
			const sha256 = options.checksumParts ? await sha256Hex(await partBlob.arrayBuffer()) : undefined;
			const part = await uploadPart(multipartPartUrl(uploadUrl, session.uploadId, partNumber), partBlob, {
				signal: options.signal,
				sha256,
				onProgress: (loadedBytes) => {
					loadedByPart.set(partNumber, loadedBytes);
					reportProgress();
				},
			});
			parts.push({ partNumber: part.partNumber, etag: part.etag });
		}
	};
	const laneCount = Math.min(options.concurrency ?? PART_CONCURRENCY, session.partCount);
	await Promise.all(
		Array.from({ length: laneCount }, () =>
			runLane().catch((error: unknown) => {
				hasFailed = true;
				throw error;
			}),
		),
	);
	return parts.sort((a, b) => a.partNumber - b.partNumber);
}

// The worker answers `409 content_unverified` until the part 1 it checked is visible where the complete runs (its
// upload state is eventually consistent across locations): the complete is retried with a growing delay.
const COMPLETE_ATTEMPTS = 3;
const COMPLETE_RETRY_DELAY_MS = 1000;

async function completeMultipart(
	uploadUrl: string,
	body: { uploadId: string; parts: MultipartPart[] },
	signal: AbortSignal | undefined,
): Promise<CapabilityUploadResult> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await postJson<CapabilityUploadResult>(multipartCompleteUrl(uploadUrl), body, signal);
		} catch (error) {
			const isUnverified = error instanceof DevulturApiError && error.code === "content_unverified";
			if (!isUnverified || attempt >= COMPLETE_ATTEMPTS) throw error;
			await new Promise((resolve) => setTimeout(resolve, COMPLETE_RETRY_DELAY_MS * attempt));
		}
	}
}

/**
 * Uploads `file` in parts to the worker's capability URL. On any failure (or abort), aborts the
 * multipart upload on the worker (best-effort) and rethrows the original error.
 */
export async function uploadMultipart(
	uploadUrl: string,
	file: Blob,
	options: MultipartUploadOptions = {},
): Promise<CapabilityUploadResult> {
	const createBody = { size: file.size, ...(options.sha256 ? { sha256: options.sha256 } : {}) };
	const session = await postJson<MultipartSession>(multipartCreateUrl(uploadUrl), createBody, options.signal);
	try {
		const parts = await uploadParts(uploadUrl, file, session, options);
		const result = await completeMultipart(uploadUrl, { uploadId: session.uploadId, parts }, options.signal);
		options.onProgress?.(100);
		return result;
	} catch (error) {
		await fetch(multipartAbortUrl(uploadUrl, session.uploadId), { method: "DELETE" }).catch(() => {});
		throw error;
	}
}

/**
 * Uploads a file to a devultur upload URL: multipart if it's large and the URL is the worker's, otherwise a
 * single PUT. Server-side (Node/edge) — in the browser use `uploadFileWithProgress` from `@devultur/react`.
 */
export async function uploadToCapabilityUrl(
	uploadUrl: string,
	file: Blob,
	options: MultipartUploadOptions & { contentType?: string } = {},
): Promise<void> {
	if (shouldUseMultipart(uploadUrl, file.size)) {
		await uploadMultipart(uploadUrl, file, options);
		return;
	}
	const response = await fetch(uploadUrl, {
		method: "PUT",
		body: file,
		headers: {
			"Content-Type": options.contentType ?? file.type,
			...(options.sha256 ? { [SHA256_HEADER]: options.sha256 } : {}),
		},
		signal: options.signal,
	});
	// The PUT is where the worker enforces limits (413 file_too_large and the worker's own ceilings).
	if (!response.ok) throw await errorFromResponse(response);
	options.onProgress?.(100);
}
