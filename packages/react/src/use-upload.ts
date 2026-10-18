"use client";

import React from "react";
import { uploadFileWithProgress } from "./upload-file";

interface UseUploadOptions {
	onUploadUrl: (file: File) => Promise<{ url: string; key: string }>;
	onComplete?: (result: { key: string; file: File }) => void;
	onProgress?: (percent: number) => void;
	onError?: (error: Error) => void;
}

interface UseUploadReturn {
	upload: (file: File) => void;
	progress: number;
	isUploading: boolean;
	error: Error | null;
	reset: () => void;
}

/**
 * Uploads a file to an upload URL (multipart for large files sent to the worker), exposing progress, error,
 * and reset controls.
 */
export function useUpload({ onUploadUrl, onComplete, onProgress, onError }: UseUploadOptions): UseUploadReturn {
	const [progress, setProgress] = React.useState(0);
	const [isUploading, setIsUploading] = React.useState(false);
	const [error, setError] = React.useState<Error | null>(null);
	const abortRef = React.useRef<AbortController | null>(null);

	const reset = React.useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setProgress(0);
		setIsUploading(false);
		setError(null);
	}, []);

	const upload = React.useCallback(
		async (file: File) => {
			reset();
			setIsUploading(true);

			const fail = (cause: unknown, fallback: string) => {
				const uploadError = cause instanceof Error ? cause : new Error(fallback);
				setError(uploadError);
				setIsUploading(false);
				onError?.(uploadError);
			};

			let target: { url: string; key: string };
			try {
				target = await onUploadUrl(file);
			} catch (err: unknown) {
				fail(err, "Failed to get upload URL");
				return;
			}

			const controller = new AbortController();
			abortRef.current = controller;
			try {
				// Archivos grandes contra el worker van en partes (ver `uploadFileWithProgress`).
				await uploadFileWithProgress(target.url, file, {
					signal: controller.signal,
					onProgress: (percent) => {
						setProgress(percent);
						onProgress?.(percent);
					},
				});
			} catch (err: unknown) {
				if (err instanceof DOMException && err.name === "AbortError") {
					setIsUploading(false);
					return;
				}
				fail(err, "Upload failed");
				return;
			} finally {
				if (abortRef.current === controller) abortRef.current = null;
			}

			setIsUploading(false);
			setProgress(100);
			onComplete?.({ key: target.key, file });
		},
		[onUploadUrl, onComplete, onProgress, onError, reset],
	);

	React.useEffect(() => {
		return () => {
			abortRef.current?.abort();
		};
	}, []);

	return { upload, progress, isUploading, error, reset };
}
