"use client";

import React from "react";
import type { VideoPlayerRenderProps } from "../types";
import { useClickOutside } from "./use-click-outside";

interface QualityButtonProps {
	state: VideoPlayerRenderProps["state"];
	controls: VideoPlayerRenderProps["controls"];
	className?: string;
}

/**
 * Control button with a menu for selecting an HLS quality level or automatic switching.
 */
export function QualityButton({ state, controls, className }: QualityButtonProps): React.ReactElement | null {
	const [isOpen, setIsOpen] = React.useState(false);
	const containerRef = React.useRef<HTMLDivElement>(null);

	useClickOutside(containerRef, isOpen, () => setIsOpen(false));

	if (state.qualityLevels.length < 2) return null;

	const activeLevel = state.currentQuality >= 0 ? state.qualityLevels[state.currentQuality] : null;
	const label = activeLevel ? `${activeLevel.height}p` : "Auto";

	return (
		<div ref={containerRef} data-dvltr-quality-wrap="">
			<button
				type="button"
				className={className}
				data-dvltr-quality-label=""
				onClick={() => setIsOpen((prev) => !prev)}
				aria-label="Video quality"
				aria-expanded={isOpen}
			>
				{label}
			</button>
			{isOpen && (
				<div data-dvltr-menu="">
					<button
						type="button"
						data-dvltr-menu-item=""
						style={{ fontWeight: state.currentQuality === -1 ? 600 : 400 }}
						onClick={() => {
							controls.setQuality(-1);
							setIsOpen(false);
						}}
					>
						Auto
					</button>
					{state.qualityLevels.map((level, index) => (
						<button
							type="button"
							key={level.height}
							data-dvltr-menu-item=""
							style={{ fontWeight: state.currentQuality === index ? 600 : 400 }}
							onClick={() => {
								controls.setQuality(index);
								setIsOpen(false);
							}}
						>
							{level.height}p
						</button>
					))}
				</div>
			)}
		</div>
	);
}
