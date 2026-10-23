"use client";

import React from "react";
import type { VideoPlayerRenderProps } from "../types";
import { resolveVideoPlayerLabels, type VideoPlayerLabels } from "../video-player-labels";
import { IconVolumeMuted, IconVolumeUp } from "./icons";
import { preventArrowDefault } from "./utils";

interface VolumeControlProps {
	state: VideoPlayerRenderProps["state"];
	controls: VideoPlayerRenderProps["controls"];
	/** Any of the player's strings (`VideoPlayerLabels`); the rest keep the English defaults. */
	labels?: Partial<VideoPlayerLabels>;
	className?: string;
}

/**
 * Mute toggle paired with a volume slider.
 */
export function VolumeControl({ state, controls, labels, className }: VolumeControlProps): React.ReactElement {
	const text = resolveVideoPlayerLabels(labels);
	const handleChange = React.useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => controls.setVolume(Number(event.target.value)),
		[controls],
	);

	const displayVolume = state.isMuted ? 0 : state.volume;

	return (
		<div className={className} data-dvltr-volume-group="">
			<button
				type="button"
				data-dvltr-btn=""
				onClick={controls.toggleMute}
				aria-label={state.isMuted ? text.unmute : text.mute}
			>
				{state.isMuted || state.volume === 0 ? <IconVolumeMuted /> : <IconVolumeUp />}
			</button>
			<input
				type="range"
				min={0}
				max={1}
				step={0.05}
				value={displayVolume}
				onChange={handleChange}
				onKeyDown={preventArrowDefault}
				aria-label={text.volume}
				data-dvltr-volume=""
				style={{
					background: `linear-gradient(to right, var(--dvltr-accent, #fff) ${displayVolume * 100}%, var(--dvltr-track-bg, rgba(255,255,255,0.3)) ${displayVolume * 100}%)`,
				}}
			/>
		</div>
	);
}
