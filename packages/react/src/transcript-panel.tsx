"use client";

import React from "react";
import type { CaptionTrack } from "./types";
import { useVttFetch } from "./use-vtt-fetch";
import { formatCueTime, type VttCue } from "./vtt-parser";

const SCROLL_IDLE_TIMEOUT_MS = 3000;

interface UseTranscriptOptions {
	captions?: CaptionTrack[];
	locale: string;
	currentTime: number;
	token?: string;
	/** Session secret → sent in `${SESSION_HEADER}` when fetching the `.vtt` (session binding). */
	sessionSecret?: string;
}

interface UseTranscriptReturn {
	cues: VttCue[];
	activeCueIndex: number;
	isLoading: boolean;
}

/**
 * Loads caption cues for a locale and tracks which cue is active at the current time.
 */
export function useTranscript({
	captions,
	locale,
	currentTime,
	token,
	sessionSecret,
}: UseTranscriptOptions): UseTranscriptReturn {
	const { cues, isLoading } = useVttFetch({ captions, locale, token, sessionSecret });

	const activeCueIndex = React.useMemo(() => {
		if (cues.length === 0) return -1;
		return cues.findIndex((cue) => currentTime >= cue.start && currentTime < cue.end);
	}, [cues, currentTime]);

	return { cues, activeCueIndex, isLoading };
}

interface TranscriptPanelProps {
	captions?: CaptionTrack[];
	locale: string;
	currentTime: number;
	token?: string;
	/** Session secret → sent in `${SESSION_HEADER}` when fetching the `.vtt` (session binding). */
	sessionSecret?: string;
	onSeek?: (seconds: number) => void;
	className?: string;
}

/**
 * Scrollable, clickable transcript that auto-scrolls to and highlights the active cue.
 */
export function TranscriptPanel({
	captions,
	locale,
	currentTime,
	token,
	sessionSecret,
	onSeek,
	className,
}: TranscriptPanelProps): React.ReactElement {
	const { cues, activeCueIndex, isLoading } = useTranscript({ captions, locale, currentTime, token, sessionSecret });
	const activeRef = React.useRef<HTMLButtonElement>(null);
	const containerRef = React.useRef<HTMLDivElement>(null);
	const userScrolledRef = React.useRef(false);
	const scrollTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: activeCueIndex triggers scroll to active cue
	React.useEffect(() => {
		if (userScrolledRef.current || !activeRef.current || !containerRef.current) return;
		const container = containerRef.current;
		const active = activeRef.current;
		const containerRect = container.getBoundingClientRect();
		const activeRect = active.getBoundingClientRect();

		if (activeRect.top < containerRect.top || activeRect.bottom > containerRect.bottom) {
			active.scrollIntoView({ behavior: "smooth", block: "center" });
		}
	}, [activeCueIndex]);

	const handleScroll = React.useCallback(() => {
		userScrolledRef.current = true;
		if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
		scrollTimeoutRef.current = setTimeout(() => {
			userScrolledRef.current = false;
		}, SCROLL_IDLE_TIMEOUT_MS);
	}, []);

	if (isLoading) {
		return <div className={className} data-dvltr-transcript="" data-loading="" />;
	}

	return (
		<div ref={containerRef} className={className} data-dvltr-transcript="" onScroll={handleScroll}>
			{cues.map((cue, index) => {
				const isActive = index === activeCueIndex;
				return (
					<button
						type="button"
						key={cue.start}
						ref={isActive ? activeRef : undefined}
						data-dvltr-transcript-cue=""
						data-active={isActive || undefined}
						onClick={() => onSeek?.(cue.start)}
					>
						<span data-dvltr-transcript-time="">{formatCueTime(cue.start)}</span>
						<span data-dvltr-transcript-text="">{cue.text}</span>
					</button>
				);
			})}
		</div>
	);
}
