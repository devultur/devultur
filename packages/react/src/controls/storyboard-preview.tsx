"use client";

import type React from "react";
import type { StoryboardCue } from "../storyboard";
import { formatTime } from "./utils";

interface StoryboardPreviewProps {
	cue: StoryboardCue;
	time: number;
	/** Horizontal center of the preview, in px from the seek bar's left edge (already clamped to the bar). */
	left: number;
}

/**
 * Thumbnail shown above the seek bar while hovering: the cue's crop of its sprite sheet plus the hovered time.
 */
export function StoryboardPreview({ cue, time, left }: StoryboardPreviewProps): React.ReactElement {
	return (
		<div
			aria-hidden="true"
			data-dvltr-storyboard=""
			style={{
				position: "absolute",
				bottom: "calc(100% + 8px)",
				left,
				transform: "translateX(-50%)",
				pointerEvents: "none",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 4,
			}}
		>
			<div
				data-dvltr-storyboard-frame=""
				style={{
					width: cue.width,
					height: cue.height,
					backgroundImage: `url("${cue.url}")`,
					backgroundPosition: `-${cue.x}px -${cue.y}px`,
					backgroundRepeat: "no-repeat",
					borderRadius: 4,
					boxShadow: "0 0 0 1px rgba(255,255,255,0.4)",
				}}
			/>
			<span data-dvltr-time="">{formatTime(time)}</span>
		</div>
	);
}
