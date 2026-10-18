// Quality-of-experience collector for one view. Pure: every handler takes the timestamp (ms) as an argument,
// so tests drive it with fake media events and fake clocks. The hook wires it to a <video> and hls.js.
//
// Each `flush` returns the DELTAS since the previous flush (or null when there is nothing new). Deltas let a
// receiver store one row per beacon and rebuild per-view totals with plain SUMs.

export const PlaybackEngine = {
	HLS_JS: "hls.js",
	NATIVE: "native",
	PROGRESSIVE: "progressive",
} as const;

export type PlaybackEngine = (typeof PlaybackEngine)[keyof typeof PlaybackEngine];

export const PLAYBACK_BEACON_VERSION = 1;

/** Wire format of one beacon (client → `POST /v1/metrics/playback`). No PII: a random view id and counters. */
export interface PlaybackBeacon {
	v: typeof PLAYBACK_BEACON_VERSION;
	viewId: string;
	/** Media key after `/v1/media/` (e.g. `public/video/{id}/hls/playlist.m3u8`). Never the token. */
	key: string;
	seq: number;
	engine: PlaybackEngine;
	/** 1 on the first beacon of the view. */
	viewStart: 0 | 1;
	/** Time to first frame, only on the beacon where the first frame happened (0 otherwise). */
	startupMs: number;
	watchMs: number;
	rebufferCount: number;
	rebufferMs: number;
	fatalErrors: number;
	nonFatalErrors: number;
	/** Last error code seen in this batch ("" when none). */
	errorCode: string;
	renditionSwitches: number;
	/** Σ(kbps × ms played at that bitrate). Average bitrate = bitrateKbpsMs / bitrateWatchMs. */
	bitrateKbpsMs: number;
	/** Watch time with a known bitrate (native HLS does not expose the rendition). */
	bitrateWatchMs: number;
	/** Increase in the furthest position reached, in percentage points. Summed per view = completion. */
	completionDelta: number;
	/** 1 on the beacon that carries the view's first fatal error. */
	erroredView: 0 | 1;
	durationS: number;
}

export interface PlaybackError {
	code: string;
	isFatal: boolean;
}

const Phase = {
	IDLE: "idle",
	STARTING: "starting",
	PLAYING: "playing",
	REBUFFERING: "rebuffering",
	PAUSED: "paused",
	ENDED: "ended",
} as const;

type Phase = (typeof Phase)[keyof typeof Phase];

interface PendingDeltas {
	startupMs: number;
	watchMs: number;
	rebufferCount: number;
	rebufferMs: number;
	fatalErrors: number;
	nonFatalErrors: number;
	errorCode: string;
	renditionSwitches: number;
	bitrateKbpsMs: number;
	bitrateWatchMs: number;
	erroredView: 0 | 1;
}

const emptyDeltas = (): PendingDeltas => ({
	startupMs: 0,
	watchMs: 0,
	rebufferCount: 0,
	rebufferMs: 0,
	fatalErrors: 0,
	nonFatalErrors: 0,
	errorCode: "",
	renditionSwitches: 0,
	bitrateKbpsMs: 0,
	bitrateWatchMs: 0,
	erroredView: 0,
});

const hasActivity = (deltas: PendingDeltas): boolean =>
	deltas.startupMs > 0 ||
	deltas.watchMs > 0 ||
	deltas.rebufferCount > 0 ||
	deltas.rebufferMs > 0 ||
	deltas.fatalErrors > 0 ||
	deltas.nonFatalErrors > 0 ||
	deltas.renditionSwitches > 0;

export interface PlaybackCollectorOptions {
	viewId: string;
	key: string;
	engine: PlaybackEngine;
}

export type PlaybackCollector = ReturnType<typeof createPlaybackCollector>;

export function createPlaybackCollector({ viewId, key, engine: initialEngine }: PlaybackCollectorOptions) {
	let engine = initialEngine;
	let phase: Phase = Phase.IDLE;
	let hasViewStarted = false;
	let isViewStartPending = false;
	let hasFirstFrame = false;
	let hasErrored = false;
	let isSeeking = false;
	let playIntentAt = 0;
	let segmentStartedAt = 0;
	let bitrateKbps = 0;
	let furthestPercent = 0;
	let reportedPercent = 0;
	let durationS = 0;
	let seq = 0;
	let deltas = emptyDeltas();

	// Closes the open playing/rebuffering segment up to `now` and restarts it there (flushes mid-segment).
	function settleSegment(now: number) {
		const elapsedMs = Math.max(0, now - segmentStartedAt);
		segmentStartedAt = now;
		if (phase === Phase.PLAYING) {
			deltas.watchMs += elapsedMs;
			if (bitrateKbps <= 0) return;
			deltas.bitrateKbpsMs += bitrateKbps * elapsedMs;
			deltas.bitrateWatchMs += elapsedMs;
			return;
		}
		if (phase === Phase.REBUFFERING) deltas.rebufferMs += elapsedMs;
	}

	function moveTo(next: Phase, now: number) {
		settleSegment(now);
		phase = next;
	}

	function handlePlayIntent(now: number) {
		if (!hasViewStarted) {
			hasViewStarted = true;
			isViewStartPending = true;
		}
		if (hasFirstFrame) return;
		playIntentAt = now;
		moveTo(Phase.STARTING, now);
	}

	return {
		handlePlayIntent,

		/** hls.js loads asynchronously: the engine is only known once it attaches (or falls back to native). */
		setEngine(nextEngine: PlaybackEngine) {
			engine = nextEngine;
		},

		handlePlaying(now: number) {
			// Autoplay can surface `playing` without a prior `play` in some browsers: it still starts the view.
			if (!hasViewStarted) handlePlayIntent(now);
			if (!hasFirstFrame) {
				hasFirstFrame = true;
				deltas.startupMs = Math.max(1, now - playIntentAt);
			}
			moveTo(Phase.PLAYING, now);
		},

		handleWaiting(now: number) {
			// Startup and seek stalls are not rebuffering: only a stall during steady playback counts.
			if (!hasFirstFrame || isSeeking || phase !== Phase.PLAYING) return;
			deltas.rebufferCount += 1;
			moveTo(Phase.REBUFFERING, now);
		},

		handlePause(now: number) {
			if (phase === Phase.IDLE || phase === Phase.ENDED) return;
			moveTo(Phase.PAUSED, now);
		},

		handleSeeking(now: number) {
			isSeeking = true;
			if (phase === Phase.PLAYING || phase === Phase.REBUFFERING) moveTo(Phase.PAUSED, now);
		},

		handleSeeked() {
			isSeeking = false;
		},

		handleEnded(now: number) {
			furthestPercent = 100;
			moveTo(Phase.ENDED, now);
		},

		handleTimeUpdate(currentTimeS: number, mediaDurationS: number) {
			if (!Number.isFinite(mediaDurationS) || mediaDurationS <= 0) return;
			durationS = mediaDurationS;
			const percent = Math.min(100, (currentTimeS / mediaDurationS) * 100);
			if (percent > furthestPercent) furthestPercent = percent;
		},

		handleRenditionSwitch(bitrateBps: number, now: number) {
			const nextKbps = Math.max(0, Math.round(bitrateBps / 1000));
			if (nextKbps === bitrateKbps) return;
			settleSegment(now);
			// The first known rendition is a selection, not a switch.
			if (bitrateKbps > 0) deltas.renditionSwitches += 1;
			bitrateKbps = nextKbps;
		},

		handleError(error: PlaybackError, now: number) {
			deltas.errorCode = error.code;
			if (!error.isFatal) {
				deltas.nonFatalErrors += 1;
				return;
			}
			deltas.fatalErrors += 1;
			// A fatal error stops playback: watch/rebuffer time stops accruing here.
			if (phase !== Phase.IDLE && phase !== Phase.ENDED) moveTo(Phase.PAUSED, now);
			if (hasErrored) return;
			hasErrored = true;
			deltas.erroredView = 1;
		},

		/** Deltas since the last flush, or null when the view never started or nothing changed. */
		flush(now: number): PlaybackBeacon | null {
			if (!hasViewStarted) return null;
			settleSegment(now);
			const completionDelta = Math.max(0, furthestPercent - reportedPercent);
			if (!isViewStartPending && !hasActivity(deltas) && completionDelta < 0.5) return null;

			const beacon: PlaybackBeacon = {
				v: PLAYBACK_BEACON_VERSION,
				viewId,
				key,
				seq,
				engine,
				viewStart: isViewStartPending ? 1 : 0,
				...deltas,
				watchMs: Math.round(deltas.watchMs),
				rebufferMs: Math.round(deltas.rebufferMs),
				bitrateKbpsMs: Math.round(deltas.bitrateKbpsMs),
				bitrateWatchMs: Math.round(deltas.bitrateWatchMs),
				completionDelta: Math.round(completionDelta * 100) / 100,
				durationS: Math.round(durationS),
			};
			seq += 1;
			isViewStartPending = false;
			reportedPercent = furthestPercent;
			deltas = emptyDeltas();
			return beacon;
		},
	};
}
