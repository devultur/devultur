import { describe, expect, it, vi } from "vitest";
import { createViewId, isViewerToken, resolveMetricsTarget } from "./beacon";
import { createPlaybackCollector, PlaybackEngine } from "./collector";
import { createMetricsSession, metricsTargetFor } from "./session";

const KEY = "public/video/vid_1/hls/playlist.m3u8";

const newCollector = () => createPlaybackCollector({ viewId: "view-1", key: KEY, engine: PlaybackEngine.HLS_JS });

// Simulated media timeline: play at t=1000, first frame at t=1450.
function startedCollector() {
	const collector = newCollector();
	collector.handlePlayIntent(1000);
	collector.handlePlaying(1450);
	return collector;
}

describe("startup time", () => {
	it("measures play intent to first frame and reports it once", () => {
		const collector = startedCollector();
		const first = collector.flush(2000);
		expect(first).toMatchObject({ viewStart: 1, startupMs: 450, seq: 0 });

		collector.handlePause(3000);
		collector.handlePlayIntent(4000);
		collector.handlePlaying(4100);
		const second = collector.flush(5000);
		expect(second).toMatchObject({ viewStart: 0, startupMs: 0, seq: 1 });
	});

	it("does not open a view until the viewer asks to play", () => {
		const collector = newCollector();
		collector.handleTimeUpdate(0, 60);
		expect(collector.flush(1000)).toBeNull();
	});

	it("starts the view on `playing` when no `play` event preceded it", () => {
		const collector = newCollector();
		collector.handlePlaying(500);
		expect(collector.flush(600)).toMatchObject({ viewStart: 1 });
	});
});

describe("watch time and rebuffering", () => {
	it("counts only steady-playback stalls as rebuffers", () => {
		const collector = startedCollector();
		collector.handleWaiting(3450); // 2 s played, then a stall
		collector.handlePlaying(4450); // 1 s rebuffering
		collector.handleSeeking(5450); // 1 s played, then a seek stall (not a rebuffer)
		collector.handleWaiting(5500);
		collector.handleSeeked();
		collector.handlePlaying(6000);
		collector.handlePause(7000); // 1 s played

		expect(collector.flush(8000)).toMatchObject({
			watchMs: 4000,
			rebufferCount: 1,
			rebufferMs: 1000,
		});
	});

	it("ignores a waiting event during startup", () => {
		const collector = newCollector();
		collector.handlePlayIntent(0);
		collector.handleWaiting(100);
		collector.handlePlaying(900);
		expect(collector.flush(1900)).toMatchObject({ startupMs: 900, rebufferCount: 0, rebufferMs: 0, watchMs: 1000 });
	});

	it("splits an open segment across flushes without losing time", () => {
		const collector = startedCollector();
		expect(collector.flush(31_450)?.watchMs).toBe(30_000);
		expect(collector.flush(41_450)?.watchMs).toBe(10_000);
	});
});

describe("bitrate", () => {
	it("weights the average by time played at each rendition and counts switches", () => {
		const collector = newCollector();
		collector.handleRenditionSwitch(2_000_000, 0); // selection, not a switch
		collector.handlePlayIntent(0);
		collector.handlePlaying(0);
		collector.handleRenditionSwitch(4_000_000, 1000);
		collector.handlePause(2000);

		const beacon = collector.flush(2000);
		expect(beacon).toMatchObject({
			renditionSwitches: 1,
			bitrateWatchMs: 2000,
			bitrateKbpsMs: 2000 * 1000 + 4000 * 1000,
		});
		expect((beacon?.bitrateKbpsMs ?? 0) / (beacon?.bitrateWatchMs ?? 1)).toBe(3000);
	});
});

describe("errors and completion", () => {
	it("flags the view once on its first fatal error and keeps the last code", () => {
		const collector = startedCollector();
		collector.handleError({ code: "networkError:fragLoadError", isFatal: false }, 2000);
		collector.handleError({ code: "mediaError:bufferStalledError", isFatal: true }, 2500);
		const first = collector.flush(3000);
		expect(first).toMatchObject({
			fatalErrors: 1,
			nonFatalErrors: 1,
			erroredView: 1,
			errorCode: "mediaError:bufferStalledError",
			watchMs: 1050,
		});

		collector.handleError({ code: "mediaError:bufferStalledError", isFatal: true }, 3500);
		expect(collector.flush(4000)).toMatchObject({ fatalErrors: 1, erroredView: 0 });
	});

	it("reports completion as deltas that sum to the furthest point reached", () => {
		const collector = startedCollector();
		collector.handleTimeUpdate(30, 120);
		const first = collector.flush(2000);
		collector.handleTimeUpdate(10, 120); // seek back: no progress
		collector.handleEnded(3000);
		const second = collector.flush(3000);
		expect(first?.completionDelta).toBe(25);
		expect(second?.completionDelta).toBe(75);
		expect(second?.durationS).toBe(120);
	});

	it("returns null when nothing changed since the last flush", () => {
		const collector = startedCollector();
		collector.handlePause(2000);
		collector.flush(2000);
		expect(collector.flush(9000)).toBeNull();
	});
});

describe("batching session", () => {
	it("sends one beacon per flush with everything recorded in between", () => {
		const send = vi.fn();
		let clock = 0;
		const session = createMetricsSession({
			target: { endpoint: "https://acme.example.com/v1/metrics/playback", key: KEY },
			engine: PlaybackEngine.HLS_JS,
			viewId: "view-1",
			now: () => clock,
			send,
		});
		expect(session.flush()).toBe(false);

		session.collector.handlePlayIntent(clock);
		clock = 300;
		session.collector.handlePlaying(clock);
		clock = 30_300;
		session.collector.handleWaiting(clock);
		clock = 31_300;
		session.collector.handlePlaying(clock);
		expect(session.flush()).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(
			"https://acme.example.com/v1/metrics/playback",
			expect.objectContaining({
				viewId: "view-1",
				startupMs: 300,
				watchMs: 30_000,
				rebufferCount: 1,
				rebufferMs: 1000,
			}),
		);
	});
});

describe("target and opt-out", () => {
	it("posts to the playback host and keeps the key without the token", () => {
		const target = resolveMetricsTarget(`https://acme.example.com/v1/media/${KEY}?token=secret`);
		expect(target).toEqual({ endpoint: "https://acme.example.com/v1/metrics/playback", key: KEY });
	});

	it("is off for sources that are not Devultur delivery URLs", () => {
		expect(resolveMetricsTarget("https://cdn.example.com/video.mp4")).toBeNull();
		expect(resolveMetricsTarget("blob:https://app.example.com/123")).toBeNull();
	});

	it("is off when the player opts out with metrics={false}", () => {
		expect(metricsTargetFor(`https://acme.example.com/v1/media/${KEY}`, false)).toBeNull();
		expect(metricsTargetFor(`https://acme.example.com/v1/media/${KEY}`, undefined)).not.toBeNull();
	});

	it("uses a fresh random id per view", () => {
		expect(createViewId()).not.toBe(createViewId());
	});
});

describe("viewer token", () => {
	const genericTarget = {
		endpoint: "https://media.example.com/v1/metrics/playback",
		key: "private/video/vid_1/hls/playlist.m3u8",
	};

	function sentBeaconWith(token: string | undefined) {
		const send = vi.fn();
		const session = createMetricsSession({
			target: genericTarget,
			engine: PlaybackEngine.HLS_JS,
			viewId: "view-1",
			now: () => 0,
			viewerToken: () => token,
			send,
		});
		session.collector.handlePlaying(0);
		session.flush();
		return send.mock.calls[0]?.[1] as Record<string, unknown>;
	}

	it("rides in the beacon body for private videos on the generic host", () => {
		expect(sentBeaconWith("header.payload.signature")).toMatchObject({ token: "header.payload.signature" });
	});

	it("never sends a non-JWT credential or a missing token", () => {
		expect(sentBeaconWith("opaque-secret")).not.toHaveProperty("token");
		expect(sentBeaconWith(undefined)).not.toHaveProperty("token");
		expect(isViewerToken("not-a-jwt")).toBe(false);
	});
});
