// Batching around one collector: everything recorded between two flushes leaves in a single beacon. The hook
// flushes every FLUSH_INTERVAL_MS, when the tab is hidden, on pagehide, and when the view ends (unmount / src
// change). Pure apart from the injected `send` and `now`, so tests drive it without timers.

import {
	createViewId,
	isViewerToken,
	type PlaybackMetricsTarget,
	resolveMetricsTarget,
	sendPlaybackBeacon,
} from "./beacon";
import { createPlaybackCollector, type PlaybackBeacon, type PlaybackCollector, type PlaybackEngine } from "./collector";

export const FLUSH_INTERVAL_MS = 30_000;

export interface MetricsSessionOptions {
	target: PlaybackMetricsTarget;
	engine: PlaybackEngine;
	viewId?: string;
	now?: () => number;
	/** Current viewer token, read at send time (it can be refreshed mid-view). */
	viewerToken?: () => string | undefined;
	send?: (endpoint: string, beacon: OutgoingBeacon) => void;
}

/**
 * What leaves the page. `token` is the viewer token of a private video played from the generic host: it rides in the
 * body (sendBeacon cannot set headers; a query param would land in request logs) only so the worker can resolve the
 * storage prefix. The worker never stores it.
 */
export type OutgoingBeacon = PlaybackBeacon & { token?: string };

export interface MetricsSession {
	collector: PlaybackCollector;
	now: () => number;
	/** Sends the pending batch, if any. Returns whether a beacon left. */
	flush: () => boolean;
}

export function createMetricsSession({
	target,
	engine,
	viewId = createViewId(),
	now = Date.now,
	viewerToken,
	send = sendPlaybackBeacon,
}: MetricsSessionOptions): MetricsSession {
	const collector = createPlaybackCollector({ viewId, key: target.key, engine });
	return {
		collector,
		now,
		flush() {
			const beacon = collector.flush(now());
			if (!beacon) return false;
			const token = viewerToken?.();
			send(target.endpoint, isViewerToken(token) ? { ...beacon, token } : beacon);
			return true;
		},
	};
}

/** The target for a player, or null when metrics are off (`metrics={false}`) or the source is not ours. */
export function metricsTargetFor(src: string, isEnabled: boolean | undefined): PlaybackMetricsTarget | null {
	if (isEnabled === false) return null;
	const baseOrigin = typeof location === "undefined" ? undefined : location.origin;
	return resolveMetricsTarget(src, baseOrigin);
}
