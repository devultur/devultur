"use client";

import type React from "react";
import type { VideoPlayerRenderProps } from "../types";
import { resolveVideoPlayerLabels, type VideoPlayerLabels } from "../video-player-labels";
import { IconFullscreen, IconFullscreenExit } from "./icons";

interface FullscreenButtonProps {
	state: VideoPlayerRenderProps["state"];
	controls: VideoPlayerRenderProps["controls"];
	/** Any of the player's strings (`VideoPlayerLabels`); the rest keep the English defaults. */
	labels?: Partial<VideoPlayerLabels>;
	className?: string;
}

/**
 * Control button that toggles the player between fullscreen and windowed modes.
 */
export function FullscreenButton({ state, controls, labels, className }: FullscreenButtonProps): React.ReactElement {
	const text = resolveVideoPlayerLabels(labels);
	return (
		<button
			type="button"
			className={className}
			data-dvltr-btn=""
			onClick={controls.toggleFullscreen}
			aria-label={state.isFullscreen ? text.exitFullscreen : text.fullscreen}
		>
			{state.isFullscreen ? <IconFullscreenExit /> : <IconFullscreen />}
		</button>
	);
}
