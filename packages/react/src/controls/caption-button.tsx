"use client";

import React from "react";
import type { CaptionTrack, VideoPlayerRenderProps } from "../types";
import { IconCaptions } from "./icons";
import { useClickOutside } from "./use-click-outside";

interface CaptionButtonProps {
	state: VideoPlayerRenderProps["state"];
	controls: VideoPlayerRenderProps["controls"];
	captions?: CaptionTrack[];
	className?: string;
}

/**
 * Control button with a menu for toggling captions and selecting a caption track.
 */
export function CaptionButton({ state, controls, captions, className }: CaptionButtonProps): React.ReactElement | null {
	const [isOpen, setIsOpen] = React.useState(false);
	const containerRef = React.useRef<HTMLDivElement>(null);

	useClickOutside(containerRef, isOpen, () => setIsOpen(false));

	if (!captions?.length) return null;

	return (
		<div ref={containerRef} data-dvltr-caption-wrap="">
			<button
				type="button"
				className={className}
				data-dvltr-btn=""
				style={{ opacity: state.activeCaption ? 1 : 0.6 }}
				onClick={() => setIsOpen((prev) => !prev)}
				aria-label="Captions"
				aria-expanded={isOpen}
			>
				<IconCaptions />
			</button>
			{isOpen && (
				<div data-dvltr-menu="">
					<button
						type="button"
						data-dvltr-menu-item=""
						style={{ fontWeight: state.activeCaption === null ? 600 : 400 }}
						onClick={() => {
							controls.setCaption(null);
							setIsOpen(false);
						}}
					>
						Off
					</button>
					{captions.map((track) => (
						<button
							type="button"
							key={track.locale}
							data-dvltr-menu-item=""
							style={{ fontWeight: state.activeCaption === track.locale ? 600 : 400 }}
							onClick={() => {
								controls.setCaption(track.locale);
								setIsOpen(false);
							}}
						>
							{track.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
