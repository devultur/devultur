import type React from "react";

export interface MediaRouterLike {
	transcode(key: string, options?: { preset?: string; callbackUrl?: string }): Promise<{ jobId: string }>;
	getTranscodeStatus(jobId: string): Promise<{ status: string; error?: string }>;
	requestCaptions(key: string, locales: string[]): Promise<{ transcriptId: string }>;
	getCaptionsStatus(transcriptId: string): Promise<{ status: string; error?: string }>;
	getMediaUrl(key: string): string;
}

/**
 * Props for the {@link UploadZone} component.
 */
export interface UploadZoneProps {
	/** Resolves the presigned upload URL and object key for the selected file. */
	onUploadUrl: (file: File) => Promise<{ url: string; key: string }>;
	/** Called once the upload finishes successfully with the stored key and file. Optional. */
	onComplete?: (result: { key: string; file: File }) => void;
	/** Called with the upload progress percentage (0-100) as it advances. Optional. */
	onProgress?: (percent: number) => void;
	/** Called when validation or the upload itself fails. Optional. */
	onError?: (error: Error) => void;
	/** Allowed MIME type patterns; files whose type does not match are rejected. Optional. */
	accept?: string[];
	/** Maximum file size in bytes; larger files are rejected. Optional. */
	maxSize?: number;
	/** Arbitrary metadata to associate with the upload. Optional. */
	metadata?: Record<string, string>;
	/** Disables interaction and drag-and-drop when true. Optional, defaults to `false`. */
	disabled?: boolean;
	/** Custom UI, or a render function receiving the current {@link UploadZoneRenderProps}. Optional. */
	children?: React.ReactNode | ((state: UploadZoneRenderProps) => React.ReactNode);
}

/**
 * State and prop getters passed to a {@link UploadZoneProps} render function.
 */
export interface UploadZoneRenderProps {
	getRootProps: () => Record<string, unknown>;
	getInputProps: () => Record<string, unknown>;
	isDragging: boolean;
	isUploading: boolean;
	progress: number;
	file: File | null;
	error: Error | null;
}

/** A playlist or segment request the player couldn't complete. */
export interface VideoPlayerError {
	/** HTTP status of the failed request, when the server answered. */
	status?: number;
	/** The `code` in the error response's JSON body (e.g. `session_mismatch`), when it had one. */
	code?: string;
	/** True when hls.js stopped playback; a 401 is reported even when hls.js would keep trying. */
	fatal: boolean;
	/** hls.js's error detail, e.g. `manifestLoadError` or `fragLoadError`. */
	details: string;
}

/**
 * Props for the {@link VideoPlayer} component.
 */
export interface VideoPlayerProps {
	/** Video source URL; `.m3u8` sources are played via HLS. */
	src: string;
	/** Bearer token sent on HLS segment requests for authenticated delivery. Optional. */
	token?: string;
	/** Session secret sent in the `X-Devultur-Session` header on hls.js/caption requests (session binding). Optional. */
	sessionSecret?: string;
	/** Caption tracks to make available in the player. Optional. */
	captions?: CaptionTrack[];
	/** Locale of the caption track to enable on first load. Optional. */
	defaultCaption?: string;
	/**
	 * Storyboard VTT URL (`buildStoryboardUrl` from `@devultur/core`, or the record's `storyboardKey` via
	 * `buildMediaUrl`). When set, hovering the seek bar shows thumbnail previews. `token` is appended for private
	 * videos. Optional.
	 */
	storyboard?: string;
	/** Playback position in seconds to seek to when metadata loads. Optional. */
	initialTime?: number;
	/** Selectable playback speeds for the speed control. Optional. */
	playbackRates?: number[];
	/** Minimum interval in milliseconds between `onProgress` callbacks. Optional. */
	progressInterval?: number;
	/** Called during playback with the current time and completion percentage. Optional. */
	onProgress?: (currentTime: number, percent: number) => void;
	/** Called when playback reaches the end of the video. Optional. */
	onEnded?: () => void;
	/** Called when the playlist or a segment can't be loaded: on a 401, and on any error hls.js can't recover from. */
	onError?: (error: VideoPlayerError) => void;
	/**
	 * Playback quality metrics (startup time, rebuffering, errors, bitrate, watch time) sent to the playback host
	 * in small batched beacons. No cookies and no personal data: a random id per view. Defaults to on for
	 * Devultur delivery URLs; pass `false` to opt out.
	 */
	metrics?: boolean;
	/** CSS aspect ratio applied to the player container. Optional. */
	aspectRatio?: string;
	/** Class name applied to the player container. Optional. */
	className?: string;
	/** Custom UI, or a render function receiving the current {@link VideoPlayerRenderProps}. Optional. */
	children?: React.ReactNode | ((state: VideoPlayerRenderProps) => React.ReactNode);
}

/**
 * Imperative handle exposed by {@link VideoPlayer} via `ref` for controlling playback.
 */
export interface VideoPlayerRef {
	seek: (time: number) => void;
	play: () => void;
	pause: () => void;
	togglePlay: () => void;
	setVolume: (volume: number) => void;
	toggleMute: () => void;
	toggleFullscreen: () => void;
	setCaption: (locale: string | null) => void;
	setPlaybackRate: (rate: number) => void;
	setQuality: (levelIndex: number) => void;
	readonly state: VideoPlayerRenderProps["state"];
}

/**
 * Describes a single HLS quality rendition available for selection.
 */
export interface QualityLevel {
	height: number;
	width: number;
	bitrate: number;
}

/**
 * A caption track exposed by the player, identified by locale.
 */
export interface CaptionTrack {
	locale: string;
	label: string;
	src: string;
}

/**
 * Playback state, controls, and video ref passed to a {@link VideoPlayerProps} render function.
 */
export interface VideoPlayerRenderProps {
	state: {
		isPlaying: boolean;
		currentTime: number;
		duration: number;
		volume: number;
		isMuted: boolean;
		isFullscreen: boolean;
		activeCaption: string | null;
		playbackRate: number;
		buffered: number;
		qualityLevels: QualityLevel[];
		currentQuality: number;
	};
	controls: {
		play: () => void;
		pause: () => void;
		togglePlay: () => void;
		seek: (time: number) => void;
		setVolume: (volume: number) => void;
		toggleMute: () => void;
		toggleFullscreen: () => void;
		setCaption: (locale: string | null) => void;
		setPlaybackRate: (rate: number) => void;
		setQuality: (levelIndex: number) => void;
	};
	ref: React.RefObject<HTMLVideoElement>;
}

/**
 * Props for the {@link CaptionSelector} component.
 */
export interface CaptionSelectorProps {
	/** Caption options to list, each with a locale value and display label. */
	captions: { locale: string; label: string }[];
	/** Locale of the currently selected caption, or `null` when captions are off. */
	activeLocale: string | null;
	/** Called with the chosen locale, or `null` when the "Off" option is selected. */
	onSelect: (locale: string | null) => void;
	/** Whether to include an "Off" option that disables captions. Optional, defaults to `true`. */
	includeOff?: boolean;
	/** Class name applied to the select element. Optional. */
	className?: string;
}

/**
 * Options for the {@link useProgress} hook.
 */
export interface UseProgressOptions {
	/** How often buffered positions are flushed to `onSave`. Optional, defaults to `"5s"`. */
	flushInterval?: "1s" | "5s" | "10s" | "30s";
}

/**
 * Value returned by the {@link useProgress} hook.
 */
export interface UseProgressReturn {
	progress: {
		lastPosition: number;
		completedAt: Date | null;
		percent: number;
	};
	isLoading: boolean;
	update: (position: number) => void;
	markComplete: () => Promise<void>;
	reset: () => Promise<void>;
}

/**
 * Props for the {@link ProgressProvider} component that wires progress persistence.
 */
export interface ProgressProviderProps {
	/** Persists the latest playback position for a video. */
	onSave: (videoId: string, position: number) => Promise<void>;
	/** Loads the stored position and completion timestamp for a video, or `null` if none. */
	onLoad: (videoId: string) => Promise<{ lastPosition: number; completedAt: Date | null } | null>;
	/** Marks a video as completed. */
	onMarkComplete: (videoId: string) => Promise<void>;
	/** Clears stored progress for a video. */
	onReset: (videoId: string) => Promise<void>;
	/** The subtree that consumes the progress context. */
	children: React.ReactNode;
}

/**
 * Progress persistence callbacks exposed through the progress context.
 */
export interface ProgressContextValue {
	save: (videoId: string, position: number) => Promise<void>;
	load: (videoId: string) => Promise<{ lastPosition: number; completedAt: Date | null } | null>;
	markComplete: (videoId: string) => Promise<void>;
	reset: (videoId: string) => Promise<void>;
}
