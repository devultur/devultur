import type { DevulturMedia } from "@devultur/core";
import type { MediaUploadError, MediaUploadState } from "@devultur/react";
import type { VideoState } from "./media-hooks";

export type UploadPhase = "idle" | "uploading" | "uploaded" | "upload-failed";

export interface UploadLocalState {
	phase: UploadPhase;
	percent: number;
	file: File | null;
	failure: MediaUploadError | null;
	media: DevulturMedia | null;
	/** The transcode was requested for the current video (distinguishes processed-video from raw/image). */
	processRequested: boolean;
}

/**
 * Derives the unified `MediaUploadState` from the local upload state ⊕ the video's reactive state
 * (`useVideoState`). Pure and with no React/Convex dependencies → testable in isolation. It's the heart of
 * the state machine: the upload phase drives things up to the persistence point; from there, for video, it
 * delegates to the reactive tail; image/file (or video without processing) go straight to `ready`.
 */
export function deriveUploadState(
	local: UploadLocalState,
	videoState: VideoState,
	retry: () => void,
): MediaUploadState {
	const { phase, percent, file, failure, media, processRequested } = local;

	if (phase === "uploading") return { phase: "uploading", percent, file: file as File };
	if (phase === "upload-failed" && failure) {
		return {
			phase: "failed",
			stage: "upload",
			reason: failure.reason,
			retriable: failure.retriable,
			message: failure.message,
			retry,
		};
	}
	if (phase === "idle" || !media) return { phase: "idle" };

	// Persistence point reached. Image/file, or video without processing → ready directly.
	if (media.kind !== "video" || !processRequested) return { phase: "ready", media };

	switch (videoState.phase) {
		case "processing":
			return { phase: "processing", media, step: videoState.step, percent: videoState.percent };
		case "ready":
			return {
				phase: "ready",
				media,
				playlist: videoState.playlist,
				duration: videoState.duration,
				captions: videoState.captions,
				playerProps: videoState.playerProps,
			};
		case "failed":
			return {
				phase: "failed",
				stage: "transcode",
				reason: videoState.reason,
				retriable: videoState.retriable,
				message: videoState.message,
				retry,
			};
		default:
			// idle (record not yet visible) or queued → "queued" (propagation window after requesting).
			return { phase: "queued", media };
	}
}
