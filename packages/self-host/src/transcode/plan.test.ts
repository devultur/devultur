/// <reference types="node" />

import { TRANSCODE_TEMPLATES, type TranscodeSpec } from "@devultur/core";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	cropFilter,
	masterPlaylistScript,
	mp4Args,
	RENDITION_LADDER,
	renditionArgs,
	SOURCE_SIZE_FILTER,
} from "../transcode-ladder";
import { MaxResolution } from "../types";
import { planTranscode } from "./plan";
import { planSetupScript } from "./plan-script";
import { posterScript, posterSeekScript } from "./poster-script";

const P720 = RENDITION_LADDER[1];
const P1080 = RENDITION_LADDER[2];

describe("crop", () => {
	it("9:16 and 1:1 centered, with escaped commas and no spaces (survive $FF_OUTPUTS)", () => {
		expect(cropFilter("9:16-center")).toBe("crop=w=min(iw\\,ih*9/16):h=min(ih\\,iw*16/9)");
		expect(cropFilter("1:1-center")).toBe("crop=w=min(iw\\,ih):h=min(iw\\,ih)");
		expect(cropFilter("9:16-center")).not.toMatch(/\s/);
	});

	it("the crop happens BEFORE scaling, also in the master's probe frame", () => {
		const args = renditionArgs(P1080, "", { crop: "9:16-center" });
		const filter = `-vf ${cropFilter("9:16-center")},scale=1080:1080:force_original_aspect_ratio=increase`;
		expect(args.split(filter).length - 1).toBe(2);
	});
});

describe("audio", () => {
	it("strip: no audio map or codec in HLS and MP4", () => {
		const hls = renditionArgs(P720, "", { stripAudio: true });
		const mp4 = mp4Args("main", P720, { stripAudio: true });
		for (const args of [hls, mp4]) {
			expect(args).not.toContain("0:a");
			expect(args).not.toContain("-c:a");
			expect(args).toContain("-an");
		}
	});

	it("keep: optional audio (`?`) in AAC", () => {
		expect(renditionArgs(P720, "")).toContain("-map 0:v -map 0:a?");
		expect(mp4Args("main", P720)).toContain("-map 0:v:0 -map 0:a:0? ");
		expect(mp4Args("main", P720)).toContain("-c:a aac -b:a 128k");
	});

	it("the master declares the AAC codec only when the output has audio (never a nonexistent one)", () => {
		const script = masterPlaylistScript();
		expect(script).toContain('if [ "$HAS_AUDIO" = true ]; then CODECS="$CODECS,mp4a.40.2"; fi');
		expect(script).toContain('CODECS=\\"$CODECS\\"');
	});
});

describe("mp4Args", () => {
	it("+faststart and file `{variant}-{rung}.mp4` outside /tmp/output", () => {
		const args = mp4Args("vertical", P1080, { crop: "9:16-center" });
		expect(args).toContain("-movflags +faststart /tmp/mp4/vertical-1080p.mp4");
		expect(args).toContain(`-vf ${cropFilter("9:16-center")},scale=1080:1080`);
		expect(args).not.toContain("/tmp/output");
	});

	it("target bitrate → single-pass ABR with a 1.5× cap and 2× buffer", () => {
		expect(mp4Args("main", P1080, { bitrateKbps: 5000 })).toContain("-b:v 5000k -maxrate 7500k -bufsize 10000k");
		expect(mp4Args("main", P1080, { bitrateKbps: 5000 })).not.toContain("-crf");
	});

	it("no bitrate → the rung's CRF with the ladder's cap", () => {
		expect(mp4Args("main", P1080)).toContain("-crf 20 -maxrate 6000k -bufsize 12000k");
	});
});

describe("planTranscode", () => {
	it("hero: main MP4 720/1080 + cropped vertical 1080, no audio, poster first", () => {
		const plan = planTranscode(TRANSCODE_TEMPLATES.hero, MaxResolution.P4K, { reportsOutputs: true });
		expect(plan.stripAudio).toBe(true);
		expect(plan.posterAt).toBe("first");
		expect(
			plan.variants.map((variant) => [variant.name, variant.crop, variant.mp4.map((m) => m.rendition.name)]),
		).toEqual([
			["main", undefined, ["720p", "1080p"]],
			["vertical", "9:16-center", ["1080p"]],
		]);
		expect(plan.variants[0]?.mp4[1]?.bitrateKbps).toBe(5000);
	});

	it("the resolution cap trims the rungs; if all exceed it, the highest allowed one is used", () => {
		const spec: TranscodeSpec = { hls: { rungs: ["720p", "4k"] }, mp4: { rungs: ["1080p"] } };
		const plan = planTranscode(spec, MaxResolution.P720, { reportsOutputs: true });
		expect(plan.variants[0]?.hls.map((rendition) => rendition.name)).toEqual(["720p"]);
		expect(plan.variants[0]?.mp4.map((output) => output.rendition.name)).toEqual(["720p"]);
	});

	it("default poster: auto, JPG + AVIF", () => {
		const plan = planTranscode({ hls: {} }, MaxResolution.P1080, { reportsOutputs: false });
		expect(plan).toMatchObject({ posterAt: "auto", posterFormats: ["jpg", "avif"], stripAudio: false });
		expect(plan.variants[0]?.hls.map((rendition) => rendition.name)).toEqual(["360p", "720p", "1080p"]);
	});
});

// Runs the setup with fake ffprobe/ffmpeg: the source and the cropped frame report the given dims.
function runSetup(spec: TranscodeSpec, dims: { source: string; crop?: string }) {
	const plan = planTranscode(spec, MaxResolution.P4K, { reportsOutputs: true });
	const stubs = [
		`ffprobe() { case "$*" in *crop-*) echo "${dims.crop ?? ""}" ;; *) echo "${dims.source}" ;; esac; }`,
		"ffmpeg() { :; }",
	];
	const keys = { playlistKey: "public/video/v1/hls/playlist.m3u8", mp4Prefix: "public/video/v1/mp4/" };
	const workdir = mkdtempSync(`${tmpdir()}/devultur-plan-`);
	const script = [...stubs, planSetupScript(plan, "", keys), 'echo "$TOP_RES|$POSTER_SHORT|$TOP_SHORT|$FF_OUTPUTS"']
		.join("\n")
		.replaceAll("/tmp/outputs.list", `${workdir}/outputs.list`);
	try {
		const line = execFileSync("sh", ["-c", script], { encoding: "utf8" }).trim().split("\n").at(-1) ?? "";
		const [top = "", posterShort = "", topShortSide = "", ffOutputs = ""] = line.split("|");
		// Each line: the file the output's real size is measured from, then the start of its rendition JSON.
		const recorded = readFileSync(`${workdir}/outputs.list`, "utf8").trim().split("\n").filter(Boolean);
		const probes = recorded.map((entry) => entry.split(" ")[0]);
		const outputs = recorded.map((entry) => JSON.parse(`${entry.slice(entry.indexOf(" ") + 1)}}`));
		return {
			count: recorded.length,
			top,
			posterShort: Number(posterShort),
			outputs,
			probes,
			ffOutputs,
			topShortSide: Number(topShortSide),
		};
	} finally {
		rmSync(workdir, { recursive: true, force: true });
	}
}

describe("planSetupScript (runtime)", () => {
	it("variants: a horizontal upload produces the horizontal MP4 and the vertical one in the same ffmpeg", () => {
		const result = runSetup(TRANSCODE_TEMPLATES.hero, { source: "1920,1080", crop: "608,1080" });
		expect(result.outputs).toEqual([
			{ variant: "main", kind: "mp4", rung: "720p", key: "public/video/v1/mp4/main-720p.mp4" },
			{ variant: "main", kind: "mp4", rung: "1080p", key: "public/video/v1/mp4/main-1080p.mp4" },
			// A 9:16 crop of a 1080p leaves a 608 px short side → doesn't reach 1080p: comes out at source size.
			{ variant: "vertical", kind: "mp4", rung: "1080p", key: "public/video/v1/mp4/vertical-1080p.mp4" },
		]);
		expect(result.count).toBe(3);
		expect(result.top).toBe("1080p");
		expect(result.posterShort).toBe(1080);
		expect(result.ffOutputs).toContain("/tmp/mp4/main-1080p.mp4");
		expect(result.ffOutputs).toContain("/tmp/mp4/vertical-1080p.mp4");
		// No upscaling: the vertical goes to the crop size (even), not to 1080×1920.
		const vertical = result.ffOutputs.split(" -map ").find((args) => args.includes("vertical-1080p.mp4")) ?? "";
		expect(vertical).toContain(`-vf ${cropFilter("9:16-center")},${SOURCE_SIZE_FILTER}`);
		expect(vertical).not.toContain("scale=1080:1080");
	});

	it("if no rung qualifies, a single output at source size and the class follows the real resolution", () => {
		const spec: TranscodeSpec = {
			variants: [
				{ name: "vertical", crop: "9:16-center", mp4: { rungs: ["1080p", "4k"], bitrate: { "1080p": 4000 } } },
			],
		};
		const result = runSetup(spec, { source: "1920,1080", crop: "608,1080" });
		expect(result.outputs).toEqual([
			{ variant: "vertical", kind: "mp4", rung: "1080p", key: "public/video/v1/mp4/vertical-1080p.mp4" },
		]);
		expect(result.count).toBe(1);
		expect(result.topShortSide).toBe(608);
		expect(result.posterShort).toBe(608);
		// The requested rung's bitrate doesn't apply to a smaller output: CRF with a cap instead.
		expect(result.ffOutputs).not.toContain("-b:v 4000k");
	});

	it("HLS: a source smaller than the whole ladder gives a rung at source size (odd short side → even)", () => {
		const result = runSetup({ hls: { rungs: ["720p", "1080p"] } }, { source: "641,481" });
		expect(result.ffOutputs).toContain(SOURCE_SIZE_FILTER);
		expect(result.posterShort).toBe(480);
		expect(result.topShortSide).toBe(480);
	});

	it("a 4K vertical reaches vertical 1080p without falling back", () => {
		const spec: TranscodeSpec = {
			variants: [{ name: "vertical", crop: "9:16-center", mp4: { rungs: ["720p", "1080p"] } }],
		};
		const result = runSetup(spec, { source: "2160,3840", crop: "2160,3840" });
		expect(result.outputs.map((output: { rung: string }) => output.rung)).toEqual(["720p", "1080p"]);
	});

	it("HLS + MP4: the ladder counts as ONE output and announces its playlist", () => {
		const result = runSetup({ hls: {}, mp4: { rungs: ["720p"] } }, { source: "1280,720" });
		expect(result.count).toBe(2);
		expect(result.outputs[0]).toEqual({
			variant: "main",
			kind: "hls",
			rung: "720p",
			key: "public/video/v1/hls/playlist.m3u8",
		});
	});
});

// The real size of each output is measured after the encode (ffmpeg.smoke.test.ts): here, from which file.
describe("file each output is measured from", () => {
	it("hero: each MP4 by its own file", () => {
		const result = runSetup(TRANSCODE_TEMPLATES.hero, { source: "1920,1080", crop: "608,1080" });
		expect(result.probes).toEqual(["/tmp/mp4/main-720p.mp4", "/tmp/mp4/main-1080p.mp4", "/tmp/mp4/vertical-1080p.mp4"]);
	});

	it("HLS ladder + MP4: the ladder counts once, by the frame of its highest rung", () => {
		const result = runSetup({ hls: {}, mp4: { rungs: ["720p"] } }, { source: "1920,1080" });
		expect(result.probes).toEqual(["/tmp/probe/1080p.jpg", "/tmp/mp4/main-720p.mp4"]);
	});

	it("main 4K + cropped vertical → the job's highest rung is 4k", () => {
		const spec: TranscodeSpec = {
			mp4: { rungs: ["4k"] },
			variants: [{ name: "vertical", crop: "9:16-center", mp4: { rungs: ["1080p"] } }],
		};
		const result = runSetup(spec, { source: "3840,2160", crop: "1216,2160" });
		expect(result.count).toBe(2);
		expect(result.top).toBe("4k");
		expect(result.topShortSide).toBe(2160);
	});
});

describe("poster", () => {
	const seekFor = (at: Parameters<typeof posterSeekScript>[0], duration: string) =>
		execFileSync("sh", ["-c", `DURATION=${duration}\n${posterSeekScript(at)}\necho "$POSTER_SEEK"`], {
			encoding: "utf8",
		}).trim();

	it("auto = min(5 s, 10% of duration): a 3 s clip doesn't fall outside the video", () => {
		expect(seekFor("auto", "3.0")).toBe("-ss 0.300");
		expect(seekFor("auto", "120")).toBe("-ss 5.000");
	});

	it("first = first decodable frame (no seek)", () => {
		expect(seekFor("first", "120")).toBe("");
	});

	it("numeric: respects the requested second; past the end falls back to auto", () => {
		expect(seekFor(2.5, "10")).toBe("-ss 2.500");
		expect(seekFor(30, "10")).toBe("-ss 1.000");
	});

	it("poster with the first frame's crop and a 640 thumbnail derived from the poster", () => {
		const plan = planTranscode(TRANSCODE_TEMPLATES["social-vertical"], MaxResolution.P1080, { reportsOutputs: true });
		const script = posterScript(plan);
		expect(script).toContain(`-vf "${cropFilter("9:16-center")},scale=$POSTER_SHORT:$POSTER_SHORT`);
		expect(script).toContain("[ -s /tmp/poster.jpg ] ||");
		expect(script).toContain('-i /tmp/poster.jpg -vf "scale=640:-2"');
	});
});
