"use client";

import React from "react";
import { useProgressContext } from "./context";
import type { UseProgressOptions, UseProgressReturn } from "./types";

const FLUSH_INTERVALS: Record<string, number> = {
	"1s": 1000,
	"5s": 5000,
	"10s": 10000,
	"30s": 30000,
};

/**
 * Tracks and persists playback progress for a single video, flushing updates on an interval.
 */
export function useProgress(videoId: string, options?: UseProgressOptions): UseProgressReturn {
	const { save, load, markComplete: contextMarkComplete, reset: contextReset } = useProgressContext();

	const flushMs = FLUSH_INTERVALS[options?.flushInterval ?? "5s"];

	const [lastPosition, setLastPosition] = React.useState(0);
	const [completedAt, setCompletedAt] = React.useState<Date | null>(null);
	const [isLoading, setIsLoading] = React.useState(true);
	const [duration, setDuration] = React.useState(0);

	const pendingPositionRef = React.useRef<number | null>(null);
	const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

	React.useEffect(() => {
		let cancelled = false;

		setIsLoading(true);
		load(videoId)
			.then((data) => {
				if (cancelled) return;
				if (data) {
					setLastPosition(data.lastPosition);
					setCompletedAt(data.completedAt);
				}
				setIsLoading(false);
			})
			.catch(() => {
				if (!cancelled) setIsLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [videoId, load]);

	React.useEffect(() => {
		timerRef.current = setInterval(() => {
			if (pendingPositionRef.current === null) return;

			const position = pendingPositionRef.current;
			pendingPositionRef.current = null;
			save(videoId, position);
		}, flushMs);

		return () => {
			if (timerRef.current) {
				clearInterval(timerRef.current);
			}

			if (pendingPositionRef.current !== null) {
				save(videoId, pendingPositionRef.current);
				pendingPositionRef.current = null;
			}
		};
	}, [videoId, save, flushMs]);

	const update = React.useCallback((position: number) => {
		setLastPosition(position);
		setDuration((prev) => Math.max(prev, position));
		pendingPositionRef.current = position;
	}, []);

	const markComplete = React.useCallback(async () => {
		await contextMarkComplete(videoId);
		setCompletedAt(new Date());
	}, [videoId, contextMarkComplete]);

	const reset = React.useCallback(async () => {
		await contextReset(videoId);
		setLastPosition(0);
		setCompletedAt(null);
	}, [videoId, contextReset]);

	const percent = duration > 0 ? Math.round((lastPosition / duration) * 100) : 0;

	return {
		progress: { lastPosition, completedAt, percent },
		isLoading,
		update,
		markComplete,
		reset,
	};
}
