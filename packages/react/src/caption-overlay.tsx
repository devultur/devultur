"use client";

import type React from "react";
import type { CaptionTrack } from "./types";
import { useVttFetch } from "./use-vtt-fetch";

interface CaptionOverlayProps {
	captions?: CaptionTrack[];
	activeLocale: string | null;
	currentTime: number;
	controlsVisible?: boolean;
	token?: string;
	sessionSecret?: string;
}

/**
 * Renders the active (and trailing) caption cue over the video for the current time.
 */
export function CaptionOverlay({
	captions,
	activeLocale,
	currentTime,
	controlsVisible = true,
	token,
	sessionSecret,
}: CaptionOverlayProps): React.ReactElement | null {
	const { cues } = useVttFetch({ captions, locale: activeLocale, token, sessionSecret });

	if (!activeLocale || cues.length === 0) return null;

	const activeIndex = cues.findIndex((cue) => currentTime >= cue.start && currentTime < cue.end);
	const activeCue = activeIndex >= 0 ? cues[activeIndex] : null;
	const previousCue = activeIndex > 0 ? cues[activeIndex - 1] : null;

	if (!activeCue) return null;

	return (
		<div data-dvltr-caption-overlay="" data-controls-visible={controlsVisible || undefined}>
			{previousCue && (
				<span
					data-dvltr-caption-text=""
					data-stale=""
					dangerouslySetInnerHTML={{ __html: previousCue.text.replace(/\n/g, "<br/>") }}
				/>
			)}
			<span data-dvltr-caption-text="" dangerouslySetInnerHTML={{ __html: activeCue.text.replace(/\n/g, "<br/>") }} />
		</div>
	);
}
