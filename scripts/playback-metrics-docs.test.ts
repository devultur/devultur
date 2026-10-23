// Docs guard: the "Playback metrics" section of the video player guide documents what the player sends. Fails when a
// beacon field, the endpoint or the flush interval changes without the guide.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMetricsTarget } from "../packages/react/src/playback-metrics/beacon";
import { createPlaybackCollector, PlaybackEngine } from "../packages/react/src/playback-metrics/collector";
import { FLUSH_INTERVAL_MS } from "../packages/react/src/playback-metrics/session";

const ROOT = join(import.meta.dirname, "..");
const guide = readFileSync(join(ROOT, "docs/guides/video-player.md"), "utf8");
const metricsSection = guide.slice(guide.indexOf("## Playback metrics"), guide.indexOf("## Labels"));
const fieldsTable = metricsSection.slice(metricsSection.indexOf("### What is sent"));

// The backticked names in the first column of each table row.
function documentedFields(): string[] {
	return fieldsTable
		.split("\n")
		.filter((line) => line.startsWith("| `"))
		.flatMap((line) => [...(line.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1] as string))
		.sort();
}

function sentFields(): string[] {
	const collector = createPlaybackCollector({
		viewId: "view",
		key: "public/video/abc/hls/playlist.m3u8",
		engine: PlaybackEngine.HLS_JS,
	});
	collector.handlePlayIntent(0);
	collector.handlePlaying(100);
	const beacon = collector.flush(1000);
	// `token` rides on top of the collector's beacon, only when the player's token is JWT-shaped.
	return [...Object.keys(beacon ?? {}), "token"].sort();
}

describe("playback metrics docs", () => {
	it("lists exactly the fields a beacon carries", () => {
		expect(documentedFields()).toEqual(sentFields());
	});

	it("documents the endpoint the player derives", () => {
		const src = "https://media.example.com/v1/media/public/video/abc/hls/playlist.m3u8";
		expect(metricsSection).toContain(src);
		expect(metricsSection).toContain(resolveMetricsTarget(src)?.endpoint);
	});

	it("documents the flush interval and the opt-out", () => {
		expect(metricsSection).toContain(`every ${FLUSH_INTERVAL_MS / 1000} seconds`);
		expect(metricsSection).toContain("metrics={false}");
		expect(metricsSection).toContain("on by default");
	});
});
