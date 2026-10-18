import { describe, expect, it } from "vitest";
import { parseEncodeMetrics, vcpuSecondsPerVideoMinute, withoutOperatorFields } from "./metrics";

const encode = { seconds: 60, cpus: 4, topRung: "1080p", runner: "fly" };

const complete = {
	event: "transcode.complete",
	videoId: "vid1",
	duration: 120,
	playlistKey: "public/video/vid1/hls/playlist.m3u8",
	thumbnailKey: "public/video/vid1/thumbnails/thumbnail.jpg",
	encode,
};

const withEncode = (fields: Record<string, unknown>) => ({ ...complete, encode: { ...encode, ...fields } });

describe("parseEncodeMetrics", () => {
	it("reads the encode measurement from transcode.complete", () => {
		expect(parseEncodeMetrics(complete)).toEqual({
			encodeSeconds: 60,
			cpus: 4,
			durationSeconds: 120,
			topRung: "1080p",
			runner: "fly",
		});
	});

	it("reads the per-title fields (complexity score, probe time, chosen params) when present and valid", () => {
		const params = [{ rung: "1080p", crf: 21, maxrateKbps: 4200 }];
		const perTitle = withEncode({ complexity: 0.4, probeSeconds: 3, params });
		expect(parseEncodeMetrics(perTitle)).toMatchObject({ complexity: 0.4, probeSeconds: 3, encodeParams: params });
		// No probe (`null`), out of range or malformed → absent; the rest of the measurement still counts.
		const invalid = withEncode({ complexity: null, params: [{ rung: "1080p", crf: "x" }] });
		expect(parseEncodeMetrics(invalid)).toEqual(parseEncodeMetrics(complete));
		expect(parseEncodeMetrics(withEncode({ complexity: 1.5 }))).not.toHaveProperty("complexity");
	});

	it("returns null without the encode seconds and for other events", () => {
		expect(parseEncodeMetrics(withEncode({ seconds: undefined }))).toBeNull();
		expect(parseEncodeMetrics({ ...complete, encode: undefined })).toBeNull();
		expect(parseEncodeMetrics({ ...complete, event: "transcode.progress" })).toBeNull();
		expect(parseEncodeMetrics(null)).toBeNull();
	});
});

describe("vcpuSecondsPerVideoMinute", () => {
	it("is wall seconds × vCPU per minute of source", () => {
		const metrics = parseEncodeMetrics(complete);
		expect(metrics && vcpuSecondsPerVideoMinute(metrics)).toBe(120);
	});

	it("is null when the vCPU count is unknown", () => {
		expect(vcpuSecondsPerVideoMinute({ encodeSeconds: 10, cpus: 0, durationSeconds: 60 })).toBeNull();
	});
});

describe("withoutOperatorFields", () => {
	it("strips the encode measurement and the poster keys before the event reaches the app's webhook", () => {
		const poster = { posterKey: "public/video/vid1/thumbnails/poster.jpg", posterFormats: ["jpg"] };
		expect(withoutOperatorFields({ ...complete, ...poster })).toEqual({
			event: "transcode.complete",
			videoId: "vid1",
			duration: 120,
			playlistKey: complete.playlistKey,
			thumbnailKey: complete.thumbnailKey,
		});
	});
});
