"use client";

import React from "react";
import type { VideoPlayerRenderProps } from "../types";
import { useClickOutside } from "./use-click-outside";

const DEFAULT_PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

interface SpeedButtonProps {
	state: VideoPlayerRenderProps["state"];
	controls: VideoPlayerRenderProps["controls"];
	rates?: number[];
	className?: string;
}

/**
 * Control button with a menu for selecting the playback speed.
 */
export function SpeedButton({
	state,
	controls,
	rates = DEFAULT_PLAYBACK_RATES,
	className,
}: SpeedButtonProps): React.ReactElement {
	const [isOpen, setIsOpen] = React.useState(false);
	const containerRef = React.useRef<HTMLDivElement>(null);

	useClickOutside(containerRef, isOpen, () => setIsOpen(false));

	const label = state.playbackRate === 1 ? "1x" : `${state.playbackRate}x`;

	return (
		<div ref={containerRef} data-dvltr-speed-wrap="">
			<button
				type="button"
				className={className}
				data-dvltr-speed-label=""
				onClick={() => setIsOpen((prev) => !prev)}
				aria-label="Playback speed"
				aria-expanded={isOpen}
			>
				{label}
			</button>
			{isOpen && (
				<div data-dvltr-menu="">
					{rates.map((rate) => (
						<button
							type="button"
							key={rate}
							data-dvltr-menu-item=""
							style={{ fontWeight: state.playbackRate === rate ? 600 : 400 }}
							onClick={() => {
								controls.setPlaybackRate(rate);
								setIsOpen(false);
							}}
						>
							{rate === 1 ? "Normal" : `${rate}x`}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
