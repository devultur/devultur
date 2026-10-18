import type { DevulturMedia, FailureReason, ProcessingPhase } from "@devultur/core";
import type { CaptionTrack, VideoPlayerProps } from "./types";

/**
 * Unified lifecycle state of a media upload, as a **discriminated union** over `phase`.
 *
 * This is the **cross-cutting** contract: both the Convex binding (reactive tail, `useMediaUpload` from
 * `@devultur/convex`) and the generic binding (polling tail) emit THIS SAME shape, so the
 * consumer writes the same `switch` on either path. Video flows
 * `uploading → queued → processing → ready`; image/file flows `uploading → ready` (no transcode).
 * `failed` covers both stages via `stage`.
 */
export type MediaUploadState =
	| { phase: "idle" }
	| { phase: "uploading"; percent: number; file: File }
	| { phase: "queued"; media: DevulturMedia }
	| { phase: "processing"; media: DevulturMedia; step: ProcessingPhase; percent: number }
	| {
			phase: "ready";
			media: DevulturMedia;
			/** Video: token-transparent HLS playlist. Image/file: `undefined`. */
			playlist?: string;
			duration?: number;
			captions?: CaptionTrack[];
			/** Video: props ready for `<VideoPlayer>`. Image/file: `undefined`. */
			playerProps?: VideoPlayerProps;
	  }
	| {
			phase: "failed";
			/** `upload` = the PUT failed (network/rejected/413/415). `transcode` = processing failed. */
			stage: "upload" | "transcode";
			reason: FailureReason | "network" | "rejected";
			retriable: boolean;
			message: string;
			/** Re-runs from the stage that failed (re-upload or re-process). */
			retry: () => void;
	  };

/** Failure reason delivered to `onError`, without `retry` (which only lives in `state`). */
export interface MediaUploadError {
	stage: "upload" | "transcode";
	reason: FailureReason | "network" | "rejected";
	retriable: boolean;
	message: string;
}
