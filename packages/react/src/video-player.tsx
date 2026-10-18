"use client";

import React from "react";
import { CaptionOverlay } from "./caption-overlay";
import { DefaultControls } from "./controls";
import type { VideoPlayerProps, VideoPlayerRef, VideoPlayerRenderProps } from "./types";
import { useStoryboard } from "./use-storyboard";
import { useVideoPlayer } from "./use-video-player";

const SEEK_STEP = 10;
const VOLUME_STEP = 0.1;

/**
 * HLS-capable video player with keyboard shortcuts, captions, and default controls.
 */
export function VideoPlayer({
	ref: forwardedRef,
	src,
	token,
	sessionSecret,
	captions,
	defaultCaption,
	storyboard,
	initialTime,
	playbackRates,
	progressInterval,
	onProgress,
	onEnded,
	metrics,
	aspectRatio,
	className,
	children,
}: VideoPlayerProps & { ref?: React.Ref<VideoPlayerRef> }): React.ReactElement {
	const containerRef = React.useRef<HTMLDivElement>(null);
	const { ref, state, controls } = useVideoPlayer({
		src,
		token,
		sessionSecret,
		initialTime,
		progressInterval,
		containerRef,
		onProgress,
		onEnded,
		metrics,
	});
	const storyboardCues = useStoryboard({ src: storyboard, token, sessionSecret });
	const hasSetDefaultCaption = React.useRef(false);
	const [controlsVisible, setControlsVisible] = React.useState(true);

	React.useImperativeHandle(
		forwardedRef,
		() => ({
			...controls,
			get state() {
				return state;
			},
		}),
		[controls, state],
	);

	React.useEffect(() => {
		if (!defaultCaption || hasSetDefaultCaption.current) return;
		hasSetDefaultCaption.current = true;
		controls.setCaption(defaultCaption);
	}, [defaultCaption, controls]);

	const handleKeyDown = React.useCallback(
		(event: React.KeyboardEvent) => {
			switch (event.key) {
				case " ": {
					event.preventDefault();
					controls.togglePlay();
					break;
				}
				case "ArrowLeft": {
					event.preventDefault();
					controls.seek(Math.max(0, state.currentTime - SEEK_STEP));
					break;
				}
				case "ArrowRight": {
					event.preventDefault();
					controls.seek(Math.min(state.duration, state.currentTime + SEEK_STEP));
					break;
				}
				case "ArrowUp": {
					event.preventDefault();
					controls.setVolume(Math.min(1, state.volume + VOLUME_STEP));
					break;
				}
				case "ArrowDown": {
					event.preventDefault();
					controls.setVolume(Math.max(0, state.volume - VOLUME_STEP));
					break;
				}
				case "f":
				case "F": {
					event.preventDefault();
					controls.toggleFullscreen();
					break;
				}
				case "c":
				case "C": {
					event.preventDefault();
					if (state.activeCaption) {
						controls.setCaption(null);
					} else if (captions?.[0]) {
						controls.setCaption(captions[0].locale);
					}
					break;
				}
				case "m":
				case "M": {
					event.preventDefault();
					controls.toggleMute();
					break;
				}
			}
		},
		[controls, state.currentTime, state.duration, state.volume, state.activeCaption, captions],
	);

	const renderProps: VideoPlayerRenderProps = {
		state,
		controls,
		ref: ref as React.RefObject<HTMLVideoElement>,
	};

	if (typeof children === "function") {
		return children(renderProps) as React.ReactElement;
	}

	return (
		<Container
			ref={containerRef}
			className={className}
			aspectRatio={aspectRatio}
			isPlaying={state.isPlaying}
			isFullscreen={state.isFullscreen}
			onKeyDown={handleKeyDown}
		>
			{/* biome-ignore lint/a11y/useMediaCaption: captions rendered via CaptionOverlay */}
			<video
				ref={ref}
				playsInline
				onClick={controls.togglePlay}
				style={{ width: "100%", height: "100%", display: "block" }}
			/>
			<CaptionOverlay
				captions={captions}
				activeLocale={state.activeCaption}
				currentTime={state.currentTime}
				controlsVisible={controlsVisible}
				token={token}
				sessionSecret={sessionSecret}
			/>
			<DefaultControls
				state={state}
				controls={controls}
				captions={captions}
				playbackRates={playbackRates}
				storyboard={storyboardCues}
				onVisibilityChange={setControlsVisible}
			/>
		</Container>
	);
}

interface ContainerProps {
	ref: React.RefObject<HTMLDivElement | null>;
	className?: string;
	aspectRatio?: string;
	isPlaying: boolean;
	isFullscreen: boolean;
	onKeyDown: (event: React.KeyboardEvent) => void;
	children: React.ReactNode;
}

function Container({ ref, className, aspectRatio, isPlaying, isFullscreen, onKeyDown, children }: ContainerProps) {
	return (
		<div
			ref={ref}
			role="application"
			aria-label="Video player"
			className={className}
			tabIndex={0}
			onKeyDown={onKeyDown}
			style={{
				position: "relative",
				overflow: "hidden",
				background: "#000",
				outline: "none",
				...(aspectRatio ? { aspectRatio } : {}),
			}}
			data-playing={isPlaying || undefined}
			data-fullscreen={isFullscreen || undefined}
		>
			{children}
		</div>
	);
}
