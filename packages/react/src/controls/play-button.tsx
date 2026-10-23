"use client";

import type React from "react";
import type { VideoPlayerRenderProps } from "../types";
import { resolveVideoPlayerLabels, type VideoPlayerLabels } from "../video-player-labels";
import { IconPause, IconPlay } from "./icons";

interface PlayButtonProps {
	state: VideoPlayerRenderProps["state"];
	controls: VideoPlayerRenderProps["controls"];
	/** Any of the player's strings (`VideoPlayerLabels`); the rest keep the English defaults. */
	labels?: Partial<VideoPlayerLabels>;
	className?: string;
}

/**
 * Control button that toggles between play and pause.
 */
export function PlayButton({ state, controls, labels, className }: PlayButtonProps): React.ReactElement {
	const text = resolveVideoPlayerLabels(labels);
	return (
		<button
			type="button"
			className={className}
			data-dvltr-btn=""
			onClick={controls.togglePlay}
			aria-label={state.isPlaying ? text.pause : text.play}
		>
			{state.isPlaying ? <IconPause /> : <IconPlay />}
		</button>
	);
}
