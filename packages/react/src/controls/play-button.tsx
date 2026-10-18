"use client";

import type React from "react";
import type { VideoPlayerRenderProps } from "../types";
import { IconPause, IconPlay } from "./icons";

interface PlayButtonProps {
	state: VideoPlayerRenderProps["state"];
	controls: VideoPlayerRenderProps["controls"];
	className?: string;
}

/**
 * Control button that toggles between play and pause.
 */
export function PlayButton({ state, controls, className }: PlayButtonProps): React.ReactElement {
	return (
		<button
			type="button"
			className={className}
			data-dvltr-btn=""
			onClick={controls.togglePlay}
			aria-label={state.isPlaying ? "Pause" : "Play"}
		>
			{state.isPlaying ? <IconPause /> : <IconPlay />}
		</button>
	);
}
