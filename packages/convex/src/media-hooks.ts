"use client";

// The hooks that follow a video through the pipeline, from the component's media record (`getMedia`).
import React from "react";
import {
	buildMediaUrl,
	CaptionLocaleLabel,
	type DevulturMedia,
	type FailureReason,
	MediaStatus,
	type MediaStatusValue,
	mediaCaptionPath,
	mediaPath,
	type ProcessingPhase,
} from "@devultur/core";
import { useQuery } from "convex/react";
import { DevulturApiContext, useDevultur } from "./devultur-context";
import type { VideoProps } from "./media-url-hooks";
import { useRequestTokenWhen } from "./request-token";

// --- useDevulturMedia (reactive media status from component's table) ---

export interface MediaStatusReturn {
	status: MediaStatusValue;
	/** Typed progress: `phase` is the pipeline step (no `as any`). */
	progress: { current: number; total: number; percent: number; phase?: ProcessingPhase } | null;
	error: string | null;
	/** Categorized failure reason (null if it didn't fail). */
	failureReason: FailureReason | null;
	/** Whether the failure is retriable (null if it didn't fail). */
	retriable: boolean | null;
	isQueued: boolean;
	isTranscoding: boolean;
	isCaptioning: boolean;
	isReady: boolean;
	isFailed: boolean;
	playlistUrl: string | null;
	thumbnailKey: string | null;
	captionLocales: string[];
	duration: number | null;
	isLoading: boolean;
}

export function useDevulturMedia(key: string | null | undefined): MediaStatusReturn {
	const apiCtx = React.use(DevulturApiContext);
	if (!apiCtx?.getMedia) {
		throw new Error("useDevulturMedia requires getMedia in DevulturProvider api");
	}

	const record = useQuery(apiCtx.getMedia, key ? { key } : "skip");

	if (!record) {
		return {
			status: MediaStatus.IDLE,
			progress: null,
			error: null,
			failureReason: null,
			retriable: null,
			isQueued: false,
			isTranscoding: false,
			isCaptioning: false,
			isReady: false,
			isFailed: false,
			playlistUrl: null,
			thumbnailKey: null,
			captionLocales: [],
			duration: null,
			isLoading: record === undefined,
		};
	}

	const status = (record.transcodeStatus as MediaStatusValue) ?? MediaStatus.IDLE;
	const isReady = status === MediaStatus.READY;
	const isFailed = status === MediaStatus.FAILED;

	const progress = record.transcodeProgress
		? {
				current: record.transcodeProgress.current as number,
				total: record.transcodeProgress.total as number,
				percent:
					(record.transcodeProgress.total as number) > 0
						? Math.round(
								((record.transcodeProgress.current as number) / (record.transcodeProgress.total as number)) * 100,
							)
						: 0,
				phase: record.transcodeProgress.phase as ProcessingPhase | undefined,
			}
		: null;

	return {
		status,
		progress,
		error: (record.transcodeError as string) ?? null,
		failureReason: isFailed ? ((record.failureReason as FailureReason) ?? "internal") : null,
		retriable: isFailed ? ((record.retriable as boolean) ?? true) : null,
		isQueued: status === MediaStatus.QUEUED,
		isTranscoding: status === MediaStatus.TRANSCODING,
		isCaptioning: status === MediaStatus.CAPTIONING,
		isReady,
		isFailed,
		playlistUrl: (record.playlistUrl as string) ?? null,
		thumbnailKey: (record.thumbnailKey as string) ?? null,
		captionLocales: (record.captionLocales as string[]) ?? [],
		duration: (record.duration as number) ?? null,
		isLoading: false,
	};
}

// --- useVideoState (discriminated union — exhaustive, typed, no boolean bag) ---

export interface CaptionTrack {
	locale: string;
	label: string;
	src: string;
}

/**
 * A video's pipeline state as a **discriminated union** on `phase`: the render is an exhaustive
 * `switch` (no boolean ordering or `as any`), and adding a new phase is a compile error until it's
 * handled. `processing` carries typed `step`/`percent`; `ready` carries the ref + props ready for
 * `<VideoPlayer>` (token-transparent); `failed` carries a categorized `reason` + `retriable`.
 */
export type VideoState =
	| { phase: "idle" }
	| { phase: "queued" }
	| { phase: "processing"; step: ProcessingPhase; percent: number }
	| {
			phase: "ready";
			media: DevulturMedia;
			playlist: string;
			duration: number;
			captions: CaptionTrack[];
			playerProps: VideoProps;
	  }
	| { phase: "failed"; reason: FailureReason; message: string; retriable: boolean };

export function useVideoState(media: DevulturMedia | null | undefined, options?: { locales?: string[] }): VideoState {
	const devultur = useDevultur();
	const { token, baseUrl, sessionSecret } = devultur;
	useRequestTokenWhen(devultur, media?.kind === "video" && media.visibility === "private");
	const status = useDevulturMedia(media?.kind === "video" ? media.id : null);
	const locales = options?.locales;

	return React.useMemo((): VideoState => {
		if (media?.kind !== "video") return { phase: "idle" };

		if (status.isFailed) {
			return {
				phase: "failed",
				reason: status.failureReason ?? "internal",
				message: status.error ?? "Video processing failed",
				retriable: status.retriable ?? true,
			};
		}

		if (status.isReady) {
			if (!baseUrl) throw new Error("useVideoState requires `baseUrl` on <DevulturProvider>");
			const viewerToken = media.visibility === "private" ? (token ?? undefined) : undefined;
			const playlist = buildMediaUrl(baseUrl, mediaPath(media), { token: viewerToken });
			const captions = (locales ?? status.captionLocales).flatMap((locale) => {
				const path = mediaCaptionPath(media, locale);
				if (!path) return [];
				const label = CaptionLocaleLabel[locale as keyof typeof CaptionLocaleLabel] ?? locale;
				return [{ locale, label, src: buildMediaUrl(baseUrl, path, { token: viewerToken }) }];
			});
			return {
				phase: "ready",
				media,
				playlist,
				duration: status.duration ?? 0,
				captions,
				playerProps: {
					src: playlist,
					token: viewerToken,
					captions,
					sessionSecret: media.visibility === "private" ? sessionSecret : undefined,
				},
			};
		}

		if (status.isQueued) return { phase: "queued" };

		if (status.isTranscoding || status.isCaptioning) {
			const step: ProcessingPhase = status.progress?.phase ?? (status.isCaptioning ? "captioning" : "encoding");
			return { phase: "processing", step, percent: status.progress?.percent ?? 0 };
		}

		return { phase: "idle" };
	}, [media, status, baseUrl, token, locales, sessionSecret]);
}
