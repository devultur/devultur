"use client";

import React from "react";
import { type StoryboardCue, storyboardCueAt } from "../storyboard";
import type { VideoPlayerRenderProps } from "../types";
import { StoryboardPreview } from "./storyboard-preview";
import { preventArrowDefault } from "./utils";

interface SeekBarProps {
	state: VideoPlayerRenderProps["state"];
	controls: VideoPlayerRenderProps["controls"];
	/** Storyboard cues (`useStoryboard`): when present, hovering the bar shows a thumbnail of that instant. */
	storyboard?: StoryboardCue[];
	className?: string;
}

interface HoverPoint {
	time: number;
	/** Preview center in px from the bar's left edge, kept inside the bar. */
	left: number;
}

/**
 * Range slider showing played and buffered progress that seeks on change, with optional storyboard previews.
 */
export function SeekBar({ state, controls, storyboard, className }: SeekBarProps): React.ReactElement {
	const [hover, setHover] = React.useState<HoverPoint | null>(null);
	const handleChange = React.useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => controls.seek(Number(event.target.value)),
		[controls],
	);

	const percent = state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0;
	const bufferedPercent = state.buffered;

	const input = (
		<input
			type="range"
			className={className}
			min={0}
			max={state.duration || 0}
			step={0.1}
			value={state.currentTime}
			onChange={handleChange}
			onKeyDown={preventArrowDefault}
			aria-label="Seek"
			data-dvltr-seek=""
			style={{
				background: `linear-gradient(to right, var(--dvltr-accent, #fff) ${percent}%, var(--dvltr-buffered, rgba(255,255,255,0.5)) ${percent}%, var(--dvltr-buffered, rgba(255,255,255,0.5)) ${bufferedPercent}%, var(--dvltr-track-bg, rgba(255,255,255,0.3)) ${bufferedPercent}%)`,
			}}
		/>
	);

	const hasStoryboard = (storyboard?.length ?? 0) > 0 && state.duration > 0;
	if (!hasStoryboard || !storyboard) return input;

	const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		const bar = event.currentTarget.getBoundingClientRect();
		if (bar.width <= 0) return;
		const fraction = Math.min(1, Math.max(0, (event.clientX - bar.left) / bar.width));
		const time = fraction * state.duration;
		const cue = storyboardCueAt(storyboard, time);
		const halfWidth = (cue?.width ?? 0) / 2;
		const left = Math.min(bar.width - halfWidth, Math.max(halfWidth, fraction * bar.width));
		setHover({ time, left });
	};

	const hoveredCue = hover ? storyboardCueAt(storyboard, hover.time) : null;

	return (
		<div
			data-dvltr-seek-wrap=""
			onPointerMove={handlePointerMove}
			onPointerLeave={() => setHover(null)}
			style={{ position: "relative", display: "flex", alignItems: "center" }}
		>
			{input}
			{hover && hoveredCue && <StoryboardPreview cue={hoveredCue} time={hover.time} left={hover.left} />}
		</div>
	);
}
