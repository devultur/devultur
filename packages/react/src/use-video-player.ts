"use client";

import React from "react";
import { SESSION_HEADER } from "@devultur/core";
import type Hls from "hls.js";
import { usePlaybackMetrics } from "./playback-metrics/use-playback-metrics";
import type { QualityLevel, VideoPlayerRenderProps } from "./types";

const HLS_EXTENSION = ".m3u8";
const HLS_MIME_TYPE = "application/vnd.apple.mpegurl";

interface UseVideoPlayerOptions {
	src: string;
	token?: string;
	/** Session secret → sent in `${SESSION_HEADER}` on hls.js requests (session binding). */
	sessionSecret?: string;
	initialTime?: number;
	progressInterval?: number;
	containerRef?: React.RefObject<HTMLElement | null>;
	onProgress?: (currentTime: number, percent: number) => void;
	onEnded?: () => void;
	/** Playback QoE metrics (startup, rebuffering, errors…) beaconed to the playback host. `false` opts out. */
	metrics?: boolean;
}

function isHlsUrl(src: string): boolean {
	return src.endsWith(HLS_EXTENSION) || src.includes(`${HLS_EXTENSION}?`);
}

interface UseVideoPlayerReturn {
	ref: React.RefObject<HTMLVideoElement | null>;
	state: VideoPlayerRenderProps["state"];
	controls: VideoPlayerRenderProps["controls"];
	hlsInstance: Hls | null;
}

/**
 * Manages video element and HLS state, returning the ref, playback state, and controls.
 */
export function useVideoPlayer({
	src,
	token,
	sessionSecret,
	initialTime,
	progressInterval,
	containerRef,
	onProgress,
	onEnded,
	metrics,
}: UseVideoPlayerOptions): UseVideoPlayerReturn {
	const ref = React.useRef<HTMLVideoElement | null>(null);
	const hlsRef = React.useRef<Hls | null>(null);
	const [hlsInstance, setHlsInstance] = React.useState<Hls | null>(null);
	const hasAppliedInitialTime = React.useRef(false);

	const [isPlaying, setIsPlaying] = React.useState(false);
	const [currentTime, setCurrentTime] = React.useState(0);
	const [duration, setDuration] = React.useState(0);
	const [volume, setVolumeState] = React.useState(1);
	const [isMuted, setIsMuted] = React.useState(false);
	const [isFullscreen, setIsFullscreen] = React.useState(false);
	const [activeCaption, setActiveCaption] = React.useState<string | null>(null);
	const [playbackRate, setPlaybackRateState] = React.useState(1);
	const [buffered, setBuffered] = React.useState(0);
	const lastProgressRef = React.useRef(0);
	const [qualityLevels, setQualityLevels] = React.useState<QualityLevel[]>([]);
	const [currentQuality, setCurrentQuality] = React.useState(-1);

	React.useEffect(() => {
		const video = ref.current;
		if (!video) return;

		if (!isHlsUrl(src)) {
			video.src = src;
			setQualityLevels([]);
			setCurrentQuality(-1);
			return undefined;
		}

		let cancelled = false;

		import("hls.js")
			.then(({ default: HlsConstructor }) => {
				if (cancelled) {
					return;
				}

				if (!HlsConstructor.isSupported()) {
					video.src = src;
					return;
				}
				const hlsConfig = token
					? {
							xhrSetup: (xhr: XMLHttpRequest, url: string) => {
								xhr.open("GET", url, true);
								xhr.setRequestHeader("Authorization", `Bearer ${token}`);
								// Session binding: the secret goes in a header (not the URL) → the playlist/segments
								// pass the session gate just like the token.
								if (sessionSecret) xhr.setRequestHeader(SESSION_HEADER, sessionSecret);
							},
						}
					: {};

				const hls = new HlsConstructor(hlsConfig);

				hls.on(HlsConstructor.Events.MANIFEST_PARSED, (_event, data) => {
					const levels = hls.levels.map((level) => ({
						height: level.height,
						width: level.width,
						bitrate: level.bitrate,
					}));
					setQualityLevels(levels);
					setCurrentQuality(hls.currentLevel);
				});

				hls.on(HlsConstructor.Events.LEVEL_SWITCHED, (_event, data) => {
					setCurrentQuality(data.level);
				});

				hls.loadSource(src);
				hls.attachMedia(video);
				hlsRef.current = hls;
				setHlsInstance(hls);
			})
			.catch(() => {
				if (!cancelled) video.src = src;
			});

		return () => {
			cancelled = true;
			hlsRef.current?.destroy();
			hlsRef.current = null;
			setHlsInstance(null);
		};
	}, [src, token, sessionSecret]);

	React.useEffect(() => {
		const video = ref.current;
		if (!video) return;

		const handlePlay = () => setIsPlaying(true);
		const handlePause = () => setIsPlaying(false);

		const handleTimeUpdate = () => {
			setCurrentTime(video.currentTime);
			if (video.duration > 0 && onProgress) {
				const now = Date.now();
				if (!progressInterval || now - lastProgressRef.current >= progressInterval) {
					lastProgressRef.current = now;
					const percent = (video.currentTime / video.duration) * 100;
					onProgress(video.currentTime, percent);
				}
			}
		};

		const handleDurationChange = () => setDuration(video.duration);
		const handleVolumeChange = () => {
			setVolumeState(video.volume);
			setIsMuted(video.muted);
		};

		const handleEnded = () => {
			setIsPlaying(false);
			onEnded?.();
		};

		const handleProgress = () => {
			if (video.buffered.length === 0) return;
			const bufferedEnd = video.buffered.end(video.buffered.length - 1);
			setBuffered(video.duration > 0 ? (bufferedEnd / video.duration) * 100 : 0);
		};

		const handleLoadedMetadata = () => {
			setDuration(video.duration);
			if (initialTime && !hasAppliedInitialTime.current) {
				video.currentTime = initialTime;
				hasAppliedInitialTime.current = true;
			}
		};

		video.addEventListener("play", handlePlay);
		video.addEventListener("pause", handlePause);
		video.addEventListener("timeupdate", handleTimeUpdate);
		video.addEventListener("durationchange", handleDurationChange);
		video.addEventListener("volumechange", handleVolumeChange);
		video.addEventListener("ended", handleEnded);
		video.addEventListener("progress", handleProgress);
		video.addEventListener("loadedmetadata", handleLoadedMetadata);

		return () => {
			video.removeEventListener("play", handlePlay);
			video.removeEventListener("pause", handlePause);
			video.removeEventListener("timeupdate", handleTimeUpdate);
			video.removeEventListener("durationchange", handleDurationChange);
			video.removeEventListener("volumechange", handleVolumeChange);
			video.removeEventListener("ended", handleEnded);
			video.removeEventListener("progress", handleProgress);
			video.removeEventListener("loadedmetadata", handleLoadedMetadata);
		};
	}, [initialTime, progressInterval, onProgress, onEnded]);

	React.useEffect(() => {
		const handleFullscreenChange = () => {
			setIsFullscreen(!!document.fullscreenElement);
		};

		document.addEventListener("fullscreenchange", handleFullscreenChange);
		return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
	}, []);

	const controls = React.useMemo(
		(): VideoPlayerRenderProps["controls"] => ({
			play: () => ref.current?.play(),
			pause: () => ref.current?.pause(),
			togglePlay: () => {
				const video = ref.current;
				if (!video) return;
				video.paused ? video.play() : video.pause();
			},
			seek: (time: number) => {
				if (!ref.current) return;
				ref.current.currentTime = time;
			},
			setVolume: (vol: number) => {
				if (!ref.current) return;
				ref.current.volume = Math.max(0, Math.min(1, vol));
			},
			toggleMute: () => {
				if (!ref.current) return;
				ref.current.muted = !ref.current.muted;
			},
			toggleFullscreen: () => {
				const target = containerRef?.current ?? ref.current;
				if (!target) return;

				if (document.fullscreenElement) {
					document.exitFullscreen();
				} else {
					target.requestFullscreen();
				}
			},
			setCaption: (locale: string | null) => {
				const video = ref.current;
				if (!video) return;

				for (let i = 0; i < video.textTracks.length; i++) {
					const track = video.textTracks[i];
					track.mode = track.language === locale ? "showing" : "hidden";
				}
				setActiveCaption(locale);
			},
			setPlaybackRate: (rate: number) => {
				if (!ref.current) return;
				ref.current.playbackRate = rate;
				setPlaybackRateState(rate);
			},
			setQuality: (levelIndex: number) => {
				if (!hlsRef.current) return;
				hlsRef.current.currentLevel = levelIndex;
			},
		}),
		[containerRef],
	);

	const state: VideoPlayerRenderProps["state"] = {
		isPlaying,
		currentTime,
		duration,
		volume,
		isMuted,
		isFullscreen,
		activeCaption,
		playbackRate,
		buffered,
		qualityLevels,
		currentQuality,
	};

	usePlaybackMetrics({ videoRef: ref, hls: hlsInstance, src, isHlsSource: isHlsUrl(src), token, isEnabled: metrics });

	return { ref, state, controls, hlsInstance };
}
