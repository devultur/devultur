"use client";

import React from "react";
import { type DevulturMedia, mediaPath, type Visibility } from "@devultur/core";
import { type MediaUploadError, type MediaUploadState, UploadHttpError, uploadFileWithProgress } from "@devultur/react";
import { useAction } from "convex/react";
import type { UploadTarget } from "./devultur-context";
import { useVideoState } from "./media-hooks";
import { deriveUploadState, type UploadPhase } from "./media-upload-derive";
import { useDevulturApi } from "./provider-hooks";
import { confirmUploadBestEffort, readImageDimensions } from "./upload-hints";

// --- useMediaUpload (unified lifecycle: upload → transcode → ready, one state machine) ---

export interface UseMediaUploadOptions {
	/** Resource visibility. Omitted → `config.upload.visibility`, else the Worker's default by type. Your guard can rewrite it. */
	visibility?: Visibility;
	/** Fires ONCE, at the persistence point (PUT done + transcode requested). */
	onComplete?: (media: DevulturMedia) => void;
	onError?: (error: MediaUploadError) => void;
	/** Deletes this old video/asset after a successful PUT (best-effort). */
	replaces?: DevulturMedia | null;
	/** Auto-request the transcode for videos. Default `true`; `false` = upload the raw file unprocessed. */
	process?: boolean;
	/** Caption locales to request when transcoding. */
	locales?: string[];
}

export interface UseMediaUploadReturn {
	/** Triggers the upload; resolves with the `DevulturMedia` at the persistence point, or `null` if cancelled/failed. */
	upload: (file: File) => Promise<DevulturMedia | null>;
	/** The reactive state machine for the full cycle. */
	state: MediaUploadState;
	/** Aborts the in-progress PUT (`uploading` phase). */
	cancel: () => void;
	/** Returns to `idle` and clears everything. */
	reset: () => void;
}

/**
 * Unified upload primitive: hides the seam between the (imperative) upload and the (reactive)
 * transcode behind ONE state machine. The consumer calls `upload(file)`, persists the ref in
 * `onComplete`, and renders a `switch` over `state.phase`. Video triggers the transcode on its own;
 * image/file go straight to `ready`. Requires `createUploadUrl` + `getMedia` in the provider (and
 * `processVideo` for video).
 */
export function useMediaUpload(options?: UseMediaUploadOptions): UseMediaUploadReturn {
	const { visibility, onComplete, onError, replaces, process, locales } = options ?? {};

	const api = useDevulturApi();
	const createUploadUrlAction = useAction(api.createUploadUrl);
	const deleteMediaAction = useAction(api.deleteMedia);
	// Fallback refs to respect the rules of hooks; only invoked if `api.confirmUpload` / `api.processVideo` exist.
	const confirmUploadAction = useAction(api.confirmUpload ?? api.createUploadUrl);
	const processVideoAction = useAction(api.processVideo ?? api.createUploadUrl);

	const [phase, setPhase] = React.useState<UploadPhase>("idle");
	const [percent, setPercent] = React.useState(0);
	const [currentFile, setCurrentFile] = React.useState<File | null>(null);
	const [media, setMedia] = React.useState<DevulturMedia | null>(null);
	const [uploadFailure, setUploadFailure] = React.useState<MediaUploadError | null>(null);
	const [processRequested, setProcessRequested] = React.useState(false);

	const abortRef = React.useRef<AbortController | null>(null);
	const lastFileRef = React.useRef<File | null>(null);
	const lastKeyRef = React.useRef<string | null>(null);

	const videoState = useVideoState(media, { locales });

	const triggerProcess = React.useCallback(
		(key: string) => {
			if (!api.processVideo) {
				throw new Error("useMediaUpload: processing a video requires `processVideo` in the <DevulturProvider> api");
			}
			lastKeyRef.current = key;
			setProcessRequested(true);
			processVideoAction({ key }).catch((err: unknown) => {
				// The real pipeline failure arrives via the component's state (transcode.failed → state.failed);
				// here we only leave a trace if the request itself couldn't even be made.
				console.error("useMediaUpload: could not request the transcode", err);
			});
		},
		[api.processVideo, processVideoAction],
	);

	const runUpload = React.useCallback(
		async (file: File): Promise<DevulturMedia | null> => {
			const controller = new AbortController();
			abortRef.current = controller;
			lastFileRef.current = file;
			setUploadFailure(null);
			setMedia(null);
			setProcessRequested(false);
			setCurrentFile(file);
			setPercent(0);
			setPhase("uploading");

			const fail = (reason: MediaUploadError["reason"], message: string): null => {
				const failure: MediaUploadError = { stage: "upload", reason, retriable: true, message };
				setUploadFailure(failure);
				setPhase("upload-failed");
				onError?.(failure);
				return null;
			};

			let result: UploadTarget;
			try {
				result = (await createUploadUrlAction({
					filename: file.name,
					contentType: file.type,
					visibility,
				})) as typeof result;
			} catch (err) {
				return fail("rejected", err instanceof Error ? err.message : "Could not start the upload");
			}

			const dimensions = await readImageDimensions(file);

			try {
				await uploadFileWithProgress(result.url, file, { onProgress: setPercent, signal: controller.signal });
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") {
					setPhase("idle");
					setCurrentFile(null);
					setPercent(0);
					return null;
				}
				const rejected = err instanceof UploadHttpError && (err.status === 413 || err.status === 415);
				return fail(rejected ? "rejected" : "network", err instanceof Error ? err.message : "The upload failed");
			}

			// Before the transcode request: both write the media record, and this one carries the upload's fields.
			if (api.confirmUpload) await confirmUploadBestEffort(confirmUploadAction, result.key, file, dimensions);

			const uploaded: DevulturMedia = {
				id: result.id,
				kind: result.kind,
				visibility: result.visibility,
				filename: file.name,
				key: result.key,
				...dimensions,
			};
			setMedia(uploaded);
			setPhase("uploaded");

			if (replaces) deleteMediaAction({ key: mediaPath(replaces) }).catch(() => {});
			onComplete?.(uploaded);

			if ((process ?? true) && uploaded.kind === "video") triggerProcess(result.key);

			return uploaded;
		},
		[
			createUploadUrlAction,
			confirmUploadAction,
			api.confirmUpload,
			deleteMediaAction,
			triggerProcess,
			visibility,
			replaces,
			process,
			onComplete,
			onError,
		],
	);

	const cancel = React.useCallback(() => {
		abortRef.current?.abort();
	}, []);

	const reset = React.useCallback(() => {
		abortRef.current?.abort();
		setPhase("idle");
		setPercent(0);
		setCurrentFile(null);
		setMedia(null);
		setUploadFailure(null);
		setProcessRequested(false);
	}, []);

	const retry = React.useCallback(() => {
		if (phase === "upload-failed" && lastFileRef.current) {
			runUpload(lastFileRef.current);
			return;
		}
		if (lastKeyRef.current) triggerProcess(lastKeyRef.current);
	}, [phase, runUpload, triggerProcess]);

	React.useEffect(() => () => abortRef.current?.abort(), []);

	const state = React.useMemo(
		(): MediaUploadState =>
			deriveUploadState(
				{ phase, percent, file: currentFile, failure: uploadFailure, media, processRequested },
				videoState,
				retry,
			),
		[phase, percent, currentFile, uploadFailure, media, processRequested, videoState, retry],
	);

	const upload = React.useCallback((file: File) => runUpload(file), [runUpload]);

	return { upload, state, cancel, reset };
}
