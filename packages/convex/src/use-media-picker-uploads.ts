"use client";

import React from "react";
import type { DevulturMedia } from "@devultur/core";
import { matchesAccept } from "./media-picker-accept";
import type { MediaPickerLabels } from "./media-picker-labels";
import type { PdfPageCounter } from "./pdf-context";
import { useDevultur } from "./react";

/** A file the picker is uploading, or one that failed (a finished upload leaves the list for the selection). */
export interface MediaPickerUpload {
	/** Stable for the upload's lifetime, for React keys and `cancel(id)`. */
	id: string;
	file: File;
	/** Bytes sent over the file's size, 0 to 1. */
	fraction: number;
	status: "uploading" | "failed";
	/** Why it failed (`labels.uploadError` or `labels.notAccepted`), `null` while uploading. */
	error: string | null;
	/** A failed upload `accept` let through can be retried; a rejected file can't. */
	canRetry: boolean;
}

interface UploadsOptions {
	accept: readonly string[] | undefined;
	multiple: boolean;
	labels: MediaPickerLabels;
	countPdfPages: PdfPageCounter | null;
	onUploaded: (media: DevulturMedia) => void;
	announce: (message: string) => void;
}

export interface MediaPickerUploads {
	uploads: MediaPickerUpload[];
	/** Uploads the files `accept` lets through (only the first one without `multiple`) and lists the rest as failed. */
	start: (files: Iterable<File>) => void;
	cancel: (id: string) => void;
	retry: (id: string) => void;
	dismiss: (id: string) => void;
}

const isAbortError = (error: unknown) =>
	typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";

const isPdf = (file: File) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

let nextUploadId = 0;

async function pageCountOf(file: File, countPdfPages: PdfPageCounter | null): Promise<number | undefined> {
	if (!countPdfPages || !isPdf(file)) return undefined;
	const pageCount = await countPdfPages(file).catch(() => null);
	return pageCount ?? undefined;
}

/** The picker's uploads: progress, cancel, retry and their failures. */
export function useMediaPickerUploads(options: UploadsOptions): MediaPickerUploads {
	const { upload } = useDevultur();
	const [uploads, setUploads] = React.useState<MediaPickerUpload[]>([]);
	const controllers = React.useRef(new Map<string, AbortController>());
	const optionsRef = React.useRef(options);
	optionsRef.current = options;

	const patch = React.useCallback((id: string, changes: Partial<MediaPickerUpload>) => {
		setUploads((current) => current.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry)));
	}, []);

	const drop = React.useCallback((id: string) => {
		controllers.current.delete(id);
		setUploads((current) => current.filter((entry) => entry.id !== id));
	}, []);

	const run = React.useCallback(
		async (id: string, file: File) => {
			const { labels, announce } = optionsRef.current;
			const controller = new AbortController();
			controllers.current.set(id, controller);
			patch(id, { status: "uploading", fraction: 0, error: null });
			announce(labels.uploading(file.name));
			try {
				const pageCount = await pageCountOf(file, optionsRef.current.countPdfPages);
				const uploaded = await upload(file, {
					pageCount,
					signal: controller.signal,
					onProgress: ({ fraction }) => patch(id, { fraction }),
				});
				drop(id);
				const media: DevulturMedia = { ...uploaded, sizeBytes: file.size, ...(pageCount ? { pageCount } : {}) };
				optionsRef.current.onUploaded(media);
				announce(labels.uploaded(file.name));
			} catch (error) {
				if (isAbortError(error)) {
					drop(id);
					announce(labels.cancelled(file.name));
					return;
				}
				controllers.current.delete(id);
				patch(id, { status: "failed", error: labels.uploadError(error), canRetry: true });
			}
		},
		[upload, patch, drop],
	);

	const start = React.useCallback(
		(files: Iterable<File>) => {
			const { accept, multiple, labels } = optionsRef.current;
			const chosen = multiple ? [...files] : [...files].slice(0, 1);
			const entries = chosen.map((file): MediaPickerUpload => {
				const isAccepted = matchesAccept(file, accept);
				return {
					id: `upload-${nextUploadId++}`,
					file,
					fraction: 0,
					status: isAccepted ? "uploading" : "failed",
					error: isAccepted ? null : labels.notAccepted(file.name),
					canRetry: false,
				};
			});
			setUploads((current) => [...current, ...entries]);
			for (const entry of entries) {
				if (entry.status === "uploading") run(entry.id, entry.file);
			}
		},
		[run],
	);

	const cancel = React.useCallback((id: string) => controllers.current.get(id)?.abort(), []);

	const retry = React.useCallback(
		(id: string) => {
			const entry = uploads.find((candidate) => candidate.id === id);
			if (!entry?.canRetry) return;
			run(id, entry.file);
		},
		[uploads, run],
	);

	React.useEffect(() => {
		const active = controllers.current;
		return () => {
			for (const controller of active.values()) controller.abort();
		};
	}, []);

	return { uploads, start, cancel, retry, dismiss: drop };
}
