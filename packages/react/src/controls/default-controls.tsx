"use client";

import React from "react";
import type { StoryboardCue } from "../storyboard";
import type { CaptionTrack, VideoPlayerRenderProps } from "../types";
import { resolveVideoPlayerLabels, type VideoPlayerLabels } from "../video-player-labels";
import { CaptionButton } from "./caption-button";
import { FullscreenButton } from "./fullscreen-button";
import { PlayButton } from "./play-button";
import { QualityButton } from "./quality-button";
import { SeekBar } from "./seek-bar";
import { SpeedButton } from "./speed-button";
import { useControlStyles } from "./styles";
import { TimeDisplay } from "./time-display";
import { VolumeControl } from "./volume-control";

const IDLE_TIMEOUT_MS = 3000;

interface DefaultControlsProps {
	state: VideoPlayerRenderProps["state"];
	controls: VideoPlayerRenderProps["controls"];
	captions?: CaptionTrack[];
	playbackRates?: number[];
	/** Storyboard cues for seek bar hover previews (`useStoryboard`). */
	storyboard?: StoryboardCue[];
	onVisibilityChange?: (visible: boolean) => void;
	/** Any of the player's strings (`VideoPlayerLabels`); the rest keep the English defaults. */
	labels?: Partial<VideoPlayerLabels>;
	className?: string;
}

/**
 * Default control bar bundling play, seek, time, quality, speed, volume, captions, and fullscreen with auto-hide.
 */
export function DefaultControls({
	state,
	controls,
	captions,
	playbackRates,
	storyboard,
	onVisibilityChange,
	labels,
	className,
}: DefaultControlsProps): React.ReactElement {
	useControlStyles();
	const text = React.useMemo(() => resolveVideoPlayerLabels(labels), [labels]);
	const [isVisible, setIsVisible] = React.useState(true);
	const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

	const resetTimer = React.useCallback(() => {
		setIsVisible(true);
		if (timeoutRef.current) clearTimeout(timeoutRef.current);
		timeoutRef.current = setTimeout(() => setIsVisible(false), IDLE_TIMEOUT_MS);
	}, []);

	React.useEffect(() => {
		if (!state.isPlaying) {
			setIsVisible(true);
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
			return;
		}
		resetTimer();
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
		};
	}, [state.isPlaying, resetTimer]);

	const showControls = isVisible || !state.isPlaying;

	React.useEffect(() => {
		onVisibilityChange?.(showControls);
	}, [showControls, onVisibilityChange]);

	return (
		<div
			className={className}
			role="toolbar"
			aria-label={text.controls}
			onMouseMove={resetTimer}
			onMouseLeave={() => state.isPlaying && setIsVisible(false)}
			data-dvltr-controls=""
			style={{
				position: "absolute",
				inset: 0,
				display: "flex",
				flexDirection: "column",
				justifyContent: "flex-end",
				cursor: showControls ? "default" : "none",
			}}
		>
			{!state.isPlaying && state.currentTime === 0 && (
				<button type="button" onClick={controls.togglePlay} aria-label={text.play} data-dvltr-big-play="">
					<svg viewBox="0 0 24 24" aria-hidden="true">
						<path d="M8 5v14l11-7z" />
					</svg>
				</button>
			)}

			<div
				data-dvltr-bar=""
				style={{
					background: "var(--dvltr-bar-bg)",
					opacity: showControls ? 1 : 0,
					pointerEvents: showControls ? "auto" : "none",
				}}
			>
				<SeekBar state={state} controls={controls} storyboard={storyboard} labels={text} />

				<div data-dvltr-bar-row="">
					<PlayButton state={state} controls={controls} labels={text} />
					<TimeDisplay state={state} />
					<div data-dvltr-spacer="" />
					<QualityButton state={state} controls={controls} labels={text} />
					<SpeedButton state={state} controls={controls} rates={playbackRates} labels={text} />
					<VolumeControl state={state} controls={controls} labels={text} />
					<CaptionButton state={state} controls={controls} captions={captions} labels={text} />
					<FullscreenButton state={state} controls={controls} labels={text} />
				</div>
			</div>
		</div>
	);
}
