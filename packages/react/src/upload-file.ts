import { DevulturApiError, type MultipartPart, shouldUseMultipart, uploadMultipart } from "@devultur/core";

/** Error of an upload PUT carrying the HTTP status → lets you tell 413 (size) / 415 (type) apart from the rest. */
export class UploadHttpError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`Upload failed with status ${status}`);
		this.name = "UploadHttpError";
		this.status = status;
	}
}

export interface UploadFileOptions {
	/** Upload progress (0-100). */
	onProgress?: (percent: number) => void;
	/** Aborts the upload when the signal fires → rejects with `AbortError`. */
	signal?: AbortSignal;
}

interface XhrPutOptions {
	contentType?: string;
	onProgress?: (loadedBytes: number, totalBytes: number) => void;
	signal?: AbortSignal;
}

const abortError = () => new DOMException("Upload aborted", "AbortError");

// A PUT via XHR (the only way to report upload progress in the browser) as a cancelable promise.
function xhrPut(url: string, body: Blob, options: XhrPutOptions): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(abortError());
			return;
		}

		const xhr = new XMLHttpRequest();

		const onAbort = () => xhr.abort();
		options.signal?.addEventListener("abort", onAbort);
		const cleanup = () => options.signal?.removeEventListener("abort", onAbort);

		xhr.upload.addEventListener("progress", (event) => {
			if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
		});

		xhr.addEventListener("load", () => {
			cleanup();
			if (xhr.status >= 200 && xhr.status < 300) {
				resolve(xhr.responseText);
				return;
			}
			reject(new UploadHttpError(xhr.status));
		});

		xhr.addEventListener("error", () => {
			cleanup();
			reject(new Error("Upload failed due to a network error"));
		});

		xhr.addEventListener("abort", () => {
			cleanup();
			reject(abortError());
		});

		xhr.open("PUT", url);
		if (options.contentType) xhr.setRequestHeader("Content-Type", options.contentType);
		xhr.send(body);
	});
}

async function uploadInParts(url: string, file: File, options?: UploadFileOptions): Promise<void> {
	try {
		await uploadMultipart(url, file, {
			onProgress: options?.onProgress,
			signal: options?.signal,
			uploadPart: async (partUrl, part, partOptions) => {
				const responseText = await xhrPut(partUrl, part, {
					signal: partOptions.signal,
					onProgress: (loadedBytes) => partOptions.onProgress(loadedBytes),
				});
				return JSON.parse(responseText) as MultipartPart;
			},
		});
	} catch (error) {
		if (options?.signal?.aborted) throw abortError();
		// Same contract as the single PUT: worker rejections (413/415/403…) arrive as UploadHttpError.
		if (error instanceof DevulturApiError) throw new UploadHttpError(error.status);
		throw error;
	}
}

/**
 * Uploads a file to an upload URL with progress, as a cancelable promise. **Cross-cutting** engine — used by
 * `useUpload` and `useMediaUpload` across every binding. Against the devultur worker, large files go in
 * parts (the worker limits the body per request); everything else, including R2's pre-signed URLs, goes in a single PUT.
 * Rejects with `UploadHttpError` (status), a network `Error`, or an `AbortError` if canceled.
 */
export async function uploadFileWithProgress(url: string, file: File, options?: UploadFileOptions): Promise<void> {
	if (shouldUseMultipart(url, file.size)) {
		await uploadInParts(url, file, options);
		return;
	}
	await xhrPut(url, file, {
		contentType: file.type,
		signal: options?.signal,
		onProgress: (loaded, total) => options?.onProgress?.(Math.round((loaded / total) * 100)),
	});
	options?.onProgress?.(100);
}
