/// <reference types="node" />

import { TRANSCODE_TEMPLATES } from "@devultur/core";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MaxResolution } from "../types";
import { planTranscode } from "./plan";
import { planSetupScript } from "./plan-script";
import { buildScript } from "./script";
import { STORYBOARD, storyboardInterval, storyboardOutputScript, storyboardVttScript } from "./storyboard-script";

const planOf = (spec: Parameters<typeof planTranscode>[0]) =>
	planTranscode(spec, MaxResolution.P1080, { reportsOutputs: true });

describe("storyboardInterval", () => {
	it("every 2 s on short and medium clips", () => {
		expect(storyboardInterval(3)).toBe(2);
		expect(storyboardInterval(600)).toBe(2);
	});

	it("grows with duration to stay under 300 thumbnails (≤ 3 sheets)", () => {
		expect(storyboardInterval(601)).toBe(3);
		expect(storyboardInterval(3600)).toBe(12);
		expect(storyboardInterval(7200)).toBe(24);
		for (const duration of [30, 601, 3599, 3600, 10_000, 36_000]) {
			expect(Math.ceil(duration / storyboardInterval(duration))).toBeLessThanOrEqual(STORYBOARD.maxThumbnails);
		}
	});

	it("invalid duration → the minimum", () => {
		expect(storyboardInterval(Number.NaN)).toBe(2);
	});
});

describe("storyboardOutputScript", () => {
	it("default: one more output of the same ffmpeg (10×10 sprites at 160 px) that doesn't add video outputs", () => {
		const setup = planSetupScript(planOf({ hls: {} }), "");
		expect(setup).toContain(
			"-map 0:v:0 -vf fps=1/$SB_INTERVAL,scale=160:-2,tile=10x10 -q:v 5 -start_number 0 /tmp/storyboard/sprite-%d.jpg",
		);
		const storyboardLine = setup.split("\n").find((line) => line.includes("/tmp/storyboard/"));
		expect(storyboardLine).not.toContain("OUTPUT_COUNT");
	});

	it("with a main-frame crop, thumbnails come out cropped like the poster", () => {
		expect(storyboardOutputScript(planOf({ hls: {}, crop: "9:16-center" })).join("\n")).toContain(
			"crop=w=min(iw\\,ih*9/16):h=min(ih\\,iw*16/9),fps=1/$SB_INTERVAL",
		);
	});

	it("storyboard: false (and the hero template) generate nothing", () => {
		expect(storyboardOutputScript(planOf({ hls: {}, storyboard: false }))).toEqual([]);
		expect(storyboardOutputScript(planOf(TRANSCODE_TEMPLATES.hero))).toEqual([]);
		const script = buildScript({
			videoId: "v1",
			maxResolution: MaxResolution.P1080,
			outputPrefix: "public/video/v1/hls/",
			thumbnailKey: "public/video/v1/thumbnails/thumbnail.jpg",
			plan: planOf({ hls: {}, storyboard: false }),
		});
		expect(script).not.toContain("sprite-");
		expect(script).toContain('STORYBOARD_KEY=""');
	});

	it("the job uploads sprites + VTT to storyboard/ and reports the key in transcode.complete", () => {
		const script = buildScript({
			videoId: "v1",
			maxResolution: MaxResolution.P1080,
			outputPrefix: "private/video/v1/hls/",
			thumbnailKey: "private/video/v1/thumbnails/thumbnail.jpg",
		});
		expect(script).toContain('STORYBOARD_KEY="private/video/v1/storyboard/storyboard.vtt"');
		expect(script).toContain('"$WORKER_URL/v1/upload/private/video/v1/storyboard/$FILENAME"');
		expect(script).toContain('*.vtt) CT="text/vtt"');
		expect(script).toContain('\\"storyboardKey\\":\\"$STORYBOARD_KEY\\"');
	});
});

// Runs the real interval and VTT shell, with a fake `ffprobe` that returns the sheet size.
describe("storyboard (shell)", () => {
	let workdir = "";

	beforeAll(() => {
		workdir = mkdtempSync(`${tmpdir()}/devultur-storyboard-`);
		mkdirSync(`${workdir}/bin`);
		writeFileSync(`${workdir}/bin/ffprobe`, '#!/bin/sh\necho "$FAKE_SHEET_DIMS"\n');
		chmodSync(`${workdir}/bin/ffprobe`, 0o755);
	});

	afterAll(() => {
		if (workdir) rmSync(workdir, { recursive: true, force: true });
	});

	function run(durationSeconds: number, sheets: number, sheetDims = "1600,900") {
		rmSync(`${workdir}/storyboard`, { recursive: true, force: true });
		mkdirSync(`${workdir}/storyboard`);
		for (let sheet = 0; sheet < sheets; sheet++) writeFileSync(`${workdir}/storyboard/sprite-${sheet}.jpg`, "jpg");
		const plan = planOf({ hls: {} });
		const script = [
			`DURATION=${durationSeconds}`,
			'FF_OUTPUTS=""',
			...storyboardOutputScript(plan),
			storyboardVttScript(plan, "public/video/v1/storyboard/storyboard.vtt"),
			'echo "RESULT $SB_INTERVAL|$STORYBOARD_KEY"',
		]
			.join("\n")
			.replaceAll("/tmp/", `${workdir}/`);
		const output = execFileSync("sh", ["-c", script], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${workdir}/bin:${process.env.PATH}`, FAKE_SHEET_DIMS: sheetDims },
		});
		const result = output.split("\n").find((line) => line.startsWith("RESULT ")) ?? "";
		const vttPath = `${workdir}/storyboard/storyboard.vtt`;
		return { result, vtt: sheets > 0 ? readFileSync(vttPath, "utf8") : "" };
	}

	it("the shell's interval matches storyboardInterval", () => {
		for (const duration of [3, 600, 601, 3600.5]) {
			expect(run(duration, 1).result.split("|")[0]).toBe(`RESULT ${storyboardInterval(duration)}`);
		}
	});

	it("VTT: one cue per thumbnail with its `#xywh` crop in the grid; the last one ends at the duration", () => {
		const { result, vtt } = run(5.5, 1);
		expect(result).toBe("RESULT 2|public/video/v1/storyboard/storyboard.vtt");
		expect(vtt).toBe(
			[
				"WEBVTT",
				"",
				"00:00:00.000 --> 00:00:02.000",
				"sprite-0.jpg#xywh=0,0,160,90",
				"",
				"00:00:02.000 --> 00:00:04.000",
				"sprite-0.jpg#xywh=160,0,160,90",
				"",
				"00:00:04.000 --> 00:00:05.500",
				"sprite-0.jpg#xywh=320,0,160,90",
				"",
			].join("\n"),
		);
	});

	it("wraps row every 10 and sheet every 100 thumbnails; hours in the timestamp", () => {
		const { vtt } = run(3700, 3, "1600,2840");
		const cues = vtt.split("\n\n").slice(1);
		// 3700 s every 13 s → 285 thumbnails.
		expect(cues).toHaveLength(285);
		expect(cues[10]).toBe("00:02:10.000 --> 00:02:23.000\nsprite-0.jpg#xywh=0,284,160,284");
		expect(cues[100]).toBe("00:21:40.000 --> 00:21:53.000\nsprite-1.jpg#xywh=0,0,160,284");
		expect(cues[284]?.trim()).toBe("01:01:32.000 --> 01:01:40.000\nsprite-2.jpg#xywh=640,2272,160,284");
	});

	it("doesn't reference thumbnails from sheets that weren't generated", () => {
		const { vtt } = run(400, 1);
		expect(vtt.split("\n\n").slice(1)).toHaveLength(100);
		expect(vtt).not.toContain("sprite-1.jpg");
	});

	it("no sprites (ffmpeg generated none) → no VTT or key: the storyboard never fails the job", () => {
		expect(run(10, 0).result).toBe("RESULT 2|");
	});
});
