"use client";

import type React from "react";
import type { VideoPlayerRenderProps } from "../types";
import { formatTime } from "./utils";

interface TimeDisplayProps {
	state: VideoPlayerRenderProps["state"];
	className?: string;
}

/**
 * Displays the current playback time and total duration as `current / total`.
 */
export function TimeDisplay({ state, className }: TimeDisplayProps): React.ReactElement {
	return (
		<span className={className} data-dvltr-time="">
			{formatTime(state.currentTime)} / {formatTime(state.duration)}
		</span>
	);
}
