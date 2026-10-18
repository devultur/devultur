import { describe, expect, it } from "vitest";
import { parseStoryboardVtt, storyboardCueAt, withStoryboardToken } from "./storyboard";

const VTT_URL = "https://acme.example.com/v1/media/private/video/v1/storyboard/storyboard.vtt?token=t";
const VTT = [
	"WEBVTT",
	"",
	"00:00:00.000 --> 00:00:02.000",
	"sprite-0.jpg?token=t#xywh=0,0,160,90",
	"",
	"00:00:02.000 --> 00:00:04.000",
	"sprite-0.jpg?token=t#xywh=160,0,160,90",
	"",
	"00:03:20.000 --> 00:03:22.000",
	"sprite-1.jpg?token=t#xywh=0,0,160,90",
	"",
].join("\n");

describe("parseStoryboardVtt", () => {
	it("resuelve cada sprite contra la URL de la VTT y conserva el token", () => {
		const cues = parseStoryboardVtt(VTT, VTT_URL);
		expect(cues[1]).toEqual({
			start: 2,
			end: 4,
			url: "https://acme.example.com/v1/media/private/video/v1/storyboard/sprite-0.jpg?token=t",
			x: 160,
			y: 0,
			width: 160,
			height: 90,
		});
		expect(cues[2]?.start).toBe(200);
	});

	it("ignora cues sin recorte #xywh", () => {
		expect(parseStoryboardVtt("WEBVTT\n\n00:00.000 --> 00:01.000\nsprite-0.jpg\n", VTT_URL)).toEqual([]);
	});
});

describe("storyboardCueAt", () => {
	const cues = parseStoryboardVtt(VTT, VTT_URL);

	it("encuentra la cue del instante (inicio inclusivo, fin exclusivo)", () => {
		expect(storyboardCueAt(cues, 0)?.x).toBe(0);
		expect(storyboardCueAt(cues, 2)?.x).toBe(160);
		expect(storyboardCueAt(cues, 201)?.url).toContain("sprite-1.jpg");
	});

	it("null en huecos o fuera del storyboard", () => {
		expect(storyboardCueAt(cues, 100)).toBeNull();
		expect(storyboardCueAt(cues, 999)).toBeNull();
		expect(storyboardCueAt([], 1)).toBeNull();
	});
});

describe("withStoryboardToken", () => {
	it("agrega el token una sola vez", () => {
		expect(withStoryboardToken("https://x/s.vtt", "t")).toBe("https://x/s.vtt?token=t");
		expect(withStoryboardToken("https://x/s.vtt?a=1", "t")).toBe("https://x/s.vtt?a=1&token=t");
		expect(withStoryboardToken("https://x/s.vtt?token=t", "t")).toBe("https://x/s.vtt?token=t");
		expect(withStoryboardToken("https://x/s.vtt", undefined)).toBe("https://x/s.vtt");
	});
});
