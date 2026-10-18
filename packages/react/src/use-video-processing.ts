"use client";

import React from "react";
import { captionPath, videoHlsPlaylistPath, videoThumbnailPath } from "@devultur/core";
import type { MediaRouterLike } from "./types";

type VideoProcessingStatus = "idle" | "starting" | "transcoding" | "captioning" | "ready" | "error";

interface UseVideoProcessingOptions {
	locales?: string[];
	/** Omitted → the worker's default preset or the usual HLS ladder. */
	preset?: string;
	pollInterval?: number;
	autoStart?: boolean;
}

interface UseVideoProcessingReturn {
	status: VideoProcessingStatus;
	transcodeReady: boolean;
	captionsReady: boolean;
	playlistUrl: string | null;
	thumbnailUrl: string | null;
	vttUrls: Record<string, string>;
	transcriptId: string | null;
	error: string | null;
	start: () => void;
}

/**
 * Drives transcode and caption jobs for an uploaded video, polling until playlist and captions are ready.
 */
export function useVideoProcessing(
	media: MediaRouterLike,
	videoKey: string | null,
	options: UseVideoProcessingOptions = {},
): UseVideoProcessingReturn {
	const { locales = [], preset, pollInterval = 5000, autoStart = true } = options;

	const localesKey = JSON.stringify(locales);
	// biome-ignore lint/correctness/useExhaustiveDependencies: localesKey is the stable serialized form of locales — using the array directly causes infinite re-renders
	const stableLocales = React.useMemo(() => locales, [localesKey]);

	const [status, setStatus] = React.useState<VideoProcessingStatus>("idle");
	const [transcodeReady, setTranscodeReady] = React.useState(false);
	const [captionsReady, setCaptionsReady] = React.useState(stableLocales.length === 0);
	const [error, setError] = React.useState<string | null>(null);
	const [transcriptId, setTranscriptId] = React.useState<string | null>(null);
	const [vttUrls, setVttUrls] = React.useState<Record<string, string>>({});

	const transcodeReadyRef = React.useRef(false);
	const captionsReadyRef = React.useRef(stableLocales.length === 0);
	const transcodeJobIdRef = React.useRef<string | null>(null);
	const captionTranscriptIdRef = React.useRef<string | null>(null);
	const intervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
	const startedRef = React.useRef(false);

	const videoId = React.useMemo(() => {
		if (!videoKey) return null;
		const parts = videoKey.split("/");
		return parts[1] ?? null;
	}, [videoKey]);

	const cleanup = React.useCallback(() => {
		if (intervalRef.current) {
			clearInterval(intervalRef.current);
			intervalRef.current = null;
		}
	}, []);

	const poll = React.useCallback(async () => {
		let allDone = true;

		if (transcodeJobIdRef.current && !transcodeReadyRef.current) {
			try {
				const result = await media.getTranscodeStatus(transcodeJobIdRef.current);
				if (result.status === "completed") {
					transcodeReadyRef.current = true;
					setTranscodeReady(true);
				} else if (result.status === "failed") {
					setError(result.error ?? "Transcode failed");
					setStatus("error");
					cleanup();
					return;
				} else {
					allDone = false;
				}
			} catch {
				allDone = false;
			}
		}

		if (captionTranscriptIdRef.current && !captionsReadyRef.current) {
			try {
				const result = await media.getCaptionsStatus(captionTranscriptIdRef.current);
				if (result.status === "completed") {
					captionsReadyRef.current = true;
					setCaptionsReady(true);
					setTranscriptId(captionTranscriptIdRef.current);
				} else if (result.status === "failed") {
					setError(result.error ?? "Captions failed");
					setStatus("error");
					cleanup();
					return;
				} else {
					allDone = false;
				}
			} catch {
				allDone = false;
			}
		}

		if (allDone) {
			setStatus("ready");
			cleanup();
		} else if (transcodeReadyRef.current && !captionsReadyRef.current) {
			setStatus("captioning");
		}
	}, [media, cleanup]);

	const start = React.useCallback(async () => {
		if (!videoKey || startedRef.current) return;
		startedRef.current = true;
		setStatus("starting");
		setError(null);

		try {
			const transcodeResult = await media.transcode(videoKey, { preset });
			transcodeJobIdRef.current = transcodeResult.jobId;
			setStatus("transcoding");

			if (stableLocales.length > 0) {
				const captionResult = await media.requestCaptions(videoKey, stableLocales);
				captionTranscriptIdRef.current = captionResult.transcriptId;
				setTranscriptId(captionResult.transcriptId);
			}

			intervalRef.current = setInterval(poll, pollInterval);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Processing failed");
			setStatus("error");
		}
	}, [videoKey, media, preset, stableLocales, pollInterval, poll]);

	React.useEffect(() => {
		if (autoStart && videoKey && !startedRef.current) {
			start();
		}
		return cleanup;
	}, [autoStart, videoKey, start, cleanup]);

	React.useEffect(() => {
		if (!captionsReady || !videoId || stableLocales.length === 0) return;
		const urls: Record<string, string> = {};
		for (const locale of stableLocales) {
			urls[locale] = media.getMediaUrl(captionPath(videoId, locale));
		}
		setVttUrls(urls);
	}, [captionsReady, videoId, stableLocales, media]);

	const playlistUrl = transcodeReady && videoId ? media.getMediaUrl(videoHlsPlaylistPath(videoId)) : null;

	const thumbnailUrl = transcodeReady && videoId ? media.getMediaUrl(videoThumbnailPath(videoId)) : null;

	return {
		status,
		transcodeReady,
		captionsReady,
		playlistUrl,
		thumbnailUrl,
		vttUrls,
		transcriptId,
		error,
		start,
	};
}
