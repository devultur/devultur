import { describe, expect, it } from "vitest";
import { buildPosterUrls, buildStoryboardUrl, buildVideoMp4Url } from "./media-url";
import { buildTranscodeOutputUrls } from "./transcode-outputs";
import { resolveTranscodePreset, TRANSCODE_TEMPLATES } from "./transcode-presets";
import { validateTranscodeSpec } from "./transcode-spec";

const errorsOf = (input: unknown) => {
	const result = validateTranscodeSpec(input);
	return result.ok ? [] : result.errors;
};

describe("validateTranscodeSpec", () => {
	it("accepts the hero case: horizontal MP4 + vertical variant, no audio, poster first", () => {
		const result = validateTranscodeSpec(TRANSCODE_TEMPLATES.hero);
		expect(result).toEqual({ ok: true, spec: TRANSCODE_TEMPLATES.hero });
	});

	it("accepts all templates", () => {
		for (const spec of Object.values(TRANSCODE_TEMPLATES)) expect(errorsOf(spec)).toEqual([]);
	});

	it("rejects unknown fields (ffmpeg args never get through)", () => {
		expect(errorsOf({ hls: {}, ffmpegArgs: "-vf evil" })).toContain("spec.ffmpegArgs: unknown field");
		expect(errorsOf({ mp4: { rungs: ["720p"], preset: "slow" } })).toContain("mp4.preset: unknown field");
	});

	it("rejects rungs, crops and audio outside the whitelist", () => {
		expect(errorsOf({ mp4: { rungs: ["8k"] } })[0]).toMatch(/unknown rung/);
		expect(errorsOf({ mp4: { rungs: [] } })[0]).toMatch(/non-empty/);
		expect(errorsOf({ mp4: { rungs: ["720p", "720p"] } })).toContain("mp4.rungs: duplicated rung");
		expect(errorsOf({ hls: {}, crop: "4:3" })[0]).toMatch(/^crop:/);
		expect(errorsOf({ hls: {}, audio: "mute" })[0]).toMatch(/^audio:/);
	});

	it("rejects bitrates out of range or for a rung the output doesn't generate", () => {
		expect(errorsOf({ mp4: { rungs: ["1080p"], bitrate: { "1080p": 50 } } })[0]).toMatch(/kbps/);
		expect(errorsOf({ mp4: { rungs: ["1080p"], bitrate: { "720p": 2000 } } })[0]).toMatch(/not one of/);
		expect(errorsOf({ mp4: { rungs: ["1080p"], bitrate: { "1080p": 2500.5 } } })[0]).toMatch(/integer/);
	});

	it("rejects an invalid poster", () => {
		expect(errorsOf({ hls: {}, poster: { at: -1 } })[0]).toMatch(/poster.at/);
		expect(errorsOf({ hls: {}, poster: { at: "middle" } })[0]).toMatch(/poster.at/);
		expect(errorsOf({ hls: {}, poster: { formats: ["png"] } })[0]).toMatch(/poster.formats/);
	});

	it("rejects malformed variants: reserved name, duplicate, HLS, or missing MP4", () => {
		const mp4 = { rungs: ["720p"] };
		expect(errorsOf({ variants: [{ name: "main", mp4 }] })[0]).toMatch(/name/);
		expect(errorsOf({ variants: [{ name: "Vertical!", mp4 }] })[0]).toMatch(/name/);
		expect(
			errorsOf({
				variants: [
					{ name: "v", mp4 },
					{ name: "v", mp4 },
				],
			}),
		).toContain("variants: names must be unique");
		expect(errorsOf({ variants: [{ name: "v", hls: {}, mp4 }] })).toContain("variants[0].hls: unknown field");
		expect(errorsOf({ variants: [{ name: "v" }] })[0]).toMatch(/variants\[0\]\.mp4/);
	});

	it("perTitle and storyboard: optional boolean switches", () => {
		expect(validateTranscodeSpec({ hls: {}, perTitle: false, storyboard: false })).toEqual({
			ok: true,
			spec: { hls: {}, perTitle: false, storyboard: false },
		});
		expect(errorsOf({ hls: {}, perTitle: "no" })).toEqual(["perTitle: must be true | false"]);
		expect(errorsOf({ hls: {}, storyboard: 1 })).toEqual(["storyboard: must be true | false"]);
		// Absent = default (enabled): the normalized spec doesn't invent them.
		expect(validateTranscodeSpec({ hls: {} })).toEqual({ ok: true, spec: { hls: {} } });
	});

	it("the hero template doesn't generate a storyboard (a background loop has no scrub bar)", () => {
		expect(TRANSCODE_TEMPLATES.hero.storyboard).toBe(false);
		expect(TRANSCODE_TEMPLATES["web-adaptive"].storyboard).toBeUndefined();
	});

	it("requires at least one output", () => {
		expect(errorsOf({ audio: "strip" })).toContain("spec: needs at least one output (hls, mp4 or variants)");
		expect(errorsOf("hls")).toEqual(["spec: must be an object"]);
	});
});

describe("resolveTranscodePreset", () => {
	const settings = {
		presets: { landing: { mp4: { rungs: ["1080p" as const] } } },
		default: "landing",
	};

	it("no preset in the request → config default", () => {
		expect(resolveTranscodePreset(undefined, settings)).toMatchObject({ ok: true, name: "landing", source: "config" });
	});

	it("no preset and no default → hls-720p (legacy)", () => {
		expect(resolveTranscodePreset(undefined, undefined)).toMatchObject({
			ok: true,
			name: "hls-720p",
			source: "legacy",
		});
	});

	it("a name resolves config → template → alias", () => {
		expect(resolveTranscodePreset("hero", settings)).toMatchObject({ ok: true, source: "template" });
		expect(resolveTranscodePreset("hls-adaptive", settings)).toMatchObject({ ok: true, source: "legacy" });
		expect(resolveTranscodePreset("nope", settings)).toEqual({ ok: false, errors: ['preset: unknown preset "nope"'] });
	});

	it("an inline spec gets validated; an invalid one gets rejected", () => {
		expect(resolveTranscodePreset({ hls: {} }, settings)).toMatchObject({ ok: true, source: "inline" });
		expect(resolveTranscodePreset({ hls: { rungs: ["2k"] } }, settings).ok).toBe(false);
	});

	it("re-validates the spec stored in the config", () => {
		const broken = { presets: { bad: { mp4: { rungs: ["9k"] } } } } as never;
		expect(resolveTranscodePreset("bad", broken).ok).toBe(false);
	});
});

describe("output URL builders", () => {
	const video = { id: "vid1", visibility: "public" as const };

	it("stable MP4 per framing and rung (main by default)", () => {
		expect(buildVideoMp4Url("https://acme.example.com", video, { rung: "1080p" })).toBe(
			"https://acme.example.com/v1/media/public/video/vid1/mp4/main-1080p.mp4",
		);
		expect(
			buildVideoMp4Url(
				"https://x",
				{ ...video, visibility: "private" },
				{ variant: "vertical", rung: "720p" },
				{ token: "t" },
			),
		).toBe("https://x/v1/media/private/video/vid1/mp4/vertical-720p.mp4?token=t");
	});

	it("storyboard: the VTT under storyboard/, with a token for private media", () => {
		expect(buildStoryboardUrl("https://x", video)).toBe(
			"https://x/v1/media/public/video/vid1/storyboard/storyboard.vtt",
		);
		expect(buildStoryboardUrl("https://x", { ...video, visibility: "private" }, { token: "t" })).toBe(
			"https://x/v1/media/private/video/vid1/storyboard/storyboard.vtt?token=t",
		);
	});

	it("poster JPG + AVIF via transform", () => {
		expect(buildPosterUrls("https://x", video)).toEqual({
			jpg: "https://x/v1/media/public/video/vid1/thumbnails/poster.jpg",
			avif: "https://x/v1/media/public/video/vid1/thumbnails/poster.jpg?format=avif",
		});
	});
});

describe("buildTranscodeOutputUrls", () => {
	const outputs = {
		renditions: [
			{ variant: "vertical", kind: "mp4" as const, rung: "1080p", key: "private/video/v1/mp4/vertical-1080p.mp4" },
		],
		posterKey: "private/video/v1/thumbnails/poster.jpg",
		posterFormats: ["jpg" as const, "avif" as const],
		hasAudio: false,
	};

	it("builds the URLs from the host it's viewed from (custom domain or subdomain), with a token if private", () => {
		expect(buildTranscodeOutputUrls("https://media.example.com", outputs, { token: "t" })).toEqual({
			renditions: [
				{
					...outputs.renditions[0],
					url: "https://media.example.com/v1/media/private/video/v1/mp4/vertical-1080p.mp4?token=t",
				},
			],
			posterUrls: {
				jpg: "https://media.example.com/v1/media/private/video/v1/thumbnails/poster.jpg?token=t",
				avif: "https://media.example.com/v1/media/private/video/v1/thumbnails/poster.jpg?token=t&format=avif",
			},
			hasAudio: false,
		});
	});

	it("only the requested poster formats; no outputs → empty list", () => {
		const jpgOnly = buildTranscodeOutputUrls("https://acme.example.com", { ...outputs, posterFormats: ["jpg"] });
		expect(Object.keys(jpgOnly.posterUrls ?? {})).toEqual(["jpg"]);
		expect(buildTranscodeOutputUrls("https://x", {})).toEqual({ renditions: [] });
	});
});
