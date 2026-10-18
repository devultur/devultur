"use client";

import type React from "react";
import type { VideoPlayerRenderProps } from "../types";
import { IconFullscreen, IconFullscreenExit } from "./icons";

interface FullscreenButtonProps {
	state: VideoPlayerRenderProps["state"];
	controls: VideoPlayerRenderProps["controls"];
	className?: string;
}

/**
 * Control button that toggles the player between fullscreen and windowed modes.
 */
export function FullscreenButton({ state, controls, className }: FullscreenButtonProps): React.ReactElement {
	return (
		<button
			type="button"
			className={className}
			data-dvltr-btn=""
			onClick={controls.toggleFullscreen}
			aria-label={state.isFullscreen ? "Exit fullscreen" : "Fullscreen"}
		>
			{state.isFullscreen ? <IconFullscreenExit /> : <IconFullscreen />}
		</button>
	);
}
