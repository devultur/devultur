"use client";

import React from "react";
import type Hls from "hls.js";
import { PlaybackEngine } from "./collector";
import { createMetricsSession, FLUSH_INTERVAL_MS, type MetricsSession, metricsTargetFor } from "./session";

interface UsePlaybackMetricsOptions {
	videoRef: React.RefObject<HTMLVideoElement | null>;
	hls: Hls | null;
	src: string;
	isHlsSource: boolean;
	/** Viewer token of a private video: lets the worker attribute beacons sent to the generic host. */
	token?: string;
	/** `false` turns collection off entirely (no listeners, no beacons). */
	isEnabled?: boolean;
}

function engineFor({ hasHlsAttached, isHlsSource }: { hasHlsAttached: boolean; isHlsSource: boolean }) {
	if (hasHlsAttached) return PlaybackEngine.HLS_JS;
	return isHlsSource ? PlaybackEngine.NATIVE : PlaybackEngine.PROGRESSIVE;
}

const nativeErrorCode = (video: HTMLVideoElement): string => `MEDIA_ERR_${video.error?.code ?? 0}`;

/**
 * Playback QoE metrics for the player: one random view per `src`, batched beacons to the playback host.
 * Opt out with `metrics={false}` on <VideoPlayer>.
 */
export function usePlaybackMetrics({
	videoRef,
	hls,
	src,
	isHlsSource,
	token,
	isEnabled,
}: UsePlaybackMetricsOptions): void {
	const sessionRef = React.useRef<MetricsSession | null>(null);
	const hasHlsAttached = React.useRef(false);
	// A ref, not an effect dependency: a refreshed token must not restart the view.
	const tokenRef = React.useRef(token);
	tokenRef.current = token;
	const target = React.useMemo(() => metricsTargetFor(src, isEnabled), [src, isEnabled]);
	const endpoint = target?.endpoint;
	const key = target?.key;

	React.useEffect(() => {
		const video = videoRef.current;
		if (!video || !endpoint || !key) return;

		const engine = engineFor({ hasHlsAttached: hasHlsAttached.current, isHlsSource });
		const session = createMetricsSession({
			target: { endpoint, key },
			engine,
			viewerToken: () => tokenRef.current,
		});
		sessionRef.current = session;
		const { collector, now } = session;

		const handlePlay = () => collector.handlePlayIntent(now());
		const handlePlaying = () => collector.handlePlaying(now());
		const handleWaiting = () => collector.handleWaiting(now());
		const handlePause = () => collector.handlePause(now());
		const handleSeeking = () => collector.handleSeeking(now());
		const handleSeeked = () => collector.handleSeeked();
		const handleTimeUpdate = () => collector.handleTimeUpdate(video.currentTime, video.duration);
		const handleEnded = () => {
			collector.handleEnded(now());
			session.flush();
		};
		// With hls.js attached its ERROR event is the source of truth (codes + fatal flag); avoid double counting.
		const handleError = () => {
			if (hasHlsAttached.current) return;
			collector.handleError({ code: nativeErrorCode(video), isFatal: true }, now());
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState === "hidden") session.flush();
		};
		const handlePageHide = () => session.flush();

		const videoListeners: Array<[string, () => void]> = [
			["play", handlePlay],
			["playing", handlePlaying],
			["waiting", handleWaiting],
			["pause", handlePause],
			["seeking", handleSeeking],
			["seeked", handleSeeked],
			["timeupdate", handleTimeUpdate],
			["ended", handleEnded],
			["error", handleError],
		];
		for (const [event, listener] of videoListeners) video.addEventListener(event, listener);
		document.addEventListener("visibilitychange", handleVisibilityChange);
		window.addEventListener("pagehide", handlePageHide);
		const flushTimer = setInterval(() => session.flush(), FLUSH_INTERVAL_MS);

		return () => {
			clearInterval(flushTimer);
			for (const [event, listener] of videoListeners) video.removeEventListener(event, listener);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			window.removeEventListener("pagehide", handlePageHide);
			session.flush();
			if (sessionRef.current === session) sessionRef.current = null;
		};
	}, [videoRef, endpoint, key, isHlsSource]);

	React.useEffect(() => {
		if (!hls || !endpoint) return;

		const { Events } = hls.constructor as typeof Hls;
		hasHlsAttached.current = true;
		sessionRef.current?.collector.setEngine(PlaybackEngine.HLS_JS);

		// Read the session at event time: it is recreated per view while the hls.js instance may outlive it.
		const handleLevelSwitched = (_event: unknown, data: { level: number }) => {
			const session = sessionRef.current;
			if (!session) return;
			session.collector.setEngine(PlaybackEngine.HLS_JS);
			session.collector.handleRenditionSwitch(hls.levels[data.level]?.bitrate ?? 0, session.now());
		};
		const handleHlsError = (_event: unknown, data: { type: string; details: string; fatal: boolean }) => {
			const session = sessionRef.current;
			if (!session) return;
			session.collector.handleError({ code: `${data.type}:${data.details}`, isFatal: data.fatal }, session.now());
		};

		hls.on(Events.LEVEL_SWITCHED, handleLevelSwitched);
		hls.on(Events.ERROR, handleHlsError);
		return () => {
			hasHlsAttached.current = false;
			hls.off(Events.LEVEL_SWITCHED, handleLevelSwitched);
			hls.off(Events.ERROR, handleHlsError);
		};
	}, [hls, endpoint]);
}
