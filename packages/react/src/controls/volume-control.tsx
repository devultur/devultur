"use client";

import React from "react";
import type { VideoPlayerRenderProps } from "../types";
import { IconVolumeMuted, IconVolumeUp } from "./icons";
import { preventArrowDefault } from "./utils";

interface VolumeControlProps {
	state: VideoPlayerRenderProps["state"];
	controls: VideoPlayerRenderProps["controls"];
	className?: string;
}

/**
 * Mute toggle paired with a volume slider.
 */
export function VolumeControl({ state, controls, className }: VolumeControlProps): React.ReactElement {
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
				aria-label={state.isMuted ? "Unmute" : "Mute"}
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
				aria-label="Volume"
				data-dvltr-volume=""
				style={{
					background: `linear-gradient(to right, var(--dvltr-accent, #fff) ${displayVolume * 100}%, var(--dvltr-track-bg, rgba(255,255,255,0.3)) ${displayVolume * 100}%)`,
				}}
			/>
		</div>
	);
}
