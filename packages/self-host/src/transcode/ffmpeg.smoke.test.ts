/// <reference types="node" />
// Smoke test with REAL ffmpeg: runs the per-title probe + the plan setup + the encode + master + poster + storyboard
// against synthetic clips (`testsrc` + `sine`, noise). Opt-in (`FFMPEG_SMOKE=1`) so ffmpeg isn't required in CI.

import type { TranscodeSpec } from "@devultur/core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { masterPlaylistScript } from "../transcode-ladder";
import { MaxResolution } from "../types";
import { perTitleScript } from "./per-title";
import { planTranscode } from "./plan";
import { planSetupScript } from "./plan-script";
import { hasAudioScript, posterScript } from "./poster-script";
import { renditionsScript } from "./script";
import { storyboardVttScript } from "./storyboard-script";

const isEnabled = process.env.FFMPEG_SMOKE === "1";

function runPlan(workdir: string, spec: TranscodeSpec): string {
	const plan = planTranscode(spec, MaxResolution.P1080, { reportsOutputs: true });
	const keys = { playlistKey: "public/video/v1/hls/playlist.m3u8", mp4Prefix: "public/video/v1/mp4/" };
	const script = [
		"set -e",
		"mkdir -p /tmp/output /tmp/probe /tmp/mp4 /tmp/storyboard",
		"DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/input)",
		"PROBE_NS=$(date +%s%N)",
		perTitleScript(plan),
		"PROBE_NS=$(( $(date +%s%N) - PROBE_NS ))",
		planSetupScript(plan, "", keys),
		"set -f",
		"ENCODE_NS=$(date +%s%N)",
		"ffmpeg -nostdin -v error -y -i /tmp/input $FF_OUTPUTS",
		"ENCODE_NS=$(( $(date +%s%N) - ENCODE_NS ))",
		"set +f",
		...renditionsScript(),
		hasAudioScript(plan),
		'if [ -n "$RENDITIONS" ]; then',
		masterPlaylistScript(),
		"fi",
		posterScript(plan),
		storyboardVttScript(plan, "public/video/v1/storyboard/storyboard.vtt"),
		'echo "PERTITLE $PT_SCORE|$PROBE_NS|$ENCODE_NS|$PT_CRF_720P|$PT_MAXRATE_720P|$STORYBOARD_KEY"',
		"echo \"RESULT $(wc -l < /tmp/outputs.list | tr -d ' ')|$TOP_SHORT|$HAS_AUDIO|[$OUTPUTS_JSON]\"",
	]
		.join("\n")
		.replaceAll("/tmp/", `${workdir}/`);
	lastOutput = execFileSync("sh", ["-c", script], { encoding: "utf8" });
	return lastOutput.split("\n").find((line) => line.startsWith("RESULT ")) ?? "";
}

let lastOutput = "";

/** `profile,level` of a file's first video stream (e.g. `High,32`). */
function h264ProfileLevelOf(path: string): string {
	return execFileSync(
		"ffprobe",
		["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=profile,level", "-of", "csv=p=0", path],
		{ encoding: "utf8" },
	)
		.trim()
		.split("\n")[0];
}

/** `renditions` of the last run's RESULT line: what `transcode.complete` reports. */
function renditionsOf(
	result: string,
): Array<{ variant: string; kind: string; rung: string; width: number; height: number }> {
	return JSON.parse(result.split("|")[3]);
}

const shortSides = (result: string) => renditionsOf(result).map(({ width, height }) => Math.min(width, height));

// `PERTITLE` line of the last run: score, probe and encode ns, CRF/maxrate 720p, and storyboard key.
function lastPerTitle() {
	const line = lastOutput.split("\n").find((entry) => entry.startsWith("PERTITLE ")) ?? "";
	const [score = "", probeNs = "0", encodeNs = "0", crf720 = "", maxrate720 = "", storyboardKey = ""] = line
		.slice("PERTITLE ".length)
		.split("|");
	return {
		score,
		probeSeconds: Number(probeNs) / 1e9,
		encodeSeconds: Number(encodeNs) / 1e9,
		crf720: Number(crf720),
		maxrate720: Number(maxrate720),
		storyboardKey,
	};
}

function synthesize(file: string, lavfi: string) {
	execFileSync("ffmpeg", [
		...["-v", "error", "-y", "-f", "lavfi", "-i", lavfi],
		...["-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-f", "mp4", file],
	]);
}

const dimsOf = (file: string) =>
	execFileSync(
		"ffprobe",
		["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
		{
			encoding: "utf8",
		},
	).trim();

const audioStreamsOf = (file: string) =>
	execFileSync(
		"ffprobe",
		["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file],
		{
			encoding: "utf8",
		},
	).trim();

describe.skipIf(!isEnabled)("ffmpeg smoke (real encode)", () => {
	let workdir = "";

	beforeAll(() => {
		workdir = mkdtempSync(`${tmpdir()}/devultur-smoke-`);
		execFileSync("ffmpeg", [
			...["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=1280x720:rate=30"],
			...[
				"-f",
				"lavfi",
				"-i",
				"sine=duration=3",
				"-shortest",
				"-c:v",
				"libx264",
				"-c:a",
				"aac",
				"-f",
				"mp4",
				`${workdir}/input`,
			],
		]);
	});

	afterAll(() => {
		if (workdir) rmSync(workdir, { recursive: true, force: true });
	});

	it("hero: HLS + horizontal MP4 + 9:16 vertical MP4, no audio, auto poster on a 3 s clip", () => {
		const result = runPlan(workdir, {
			hls: { rungs: ["360p", "720p"] },
			mp4: { rungs: ["720p"], bitrate: { "720p": 1500 } },
			audio: "strip",
			variants: [{ name: "vertical", crop: "9:16-center", mp4: { rungs: ["720p"] } }],
		});
		expect(result).toMatch(/^RESULT 3\|720\|false\|\[/);
		expect(renditionsOf(result)).toEqual([
			expect.objectContaining({ variant: "main", kind: "hls", rung: "720p", width: 1280, height: 720 }),
			expect.objectContaining({ variant: "main", kind: "mp4", rung: "720p", width: 1280, height: 720 }),
			expect.objectContaining({ variant: "vertical", kind: "mp4", rung: "720p", width: 404, height: 720 }),
		]);
		expect(shortSides(result)).toEqual([720, 720, 404]);

		expect(dimsOf(`${workdir}/mp4/main-720p.mp4`)).toBe("1280,720");
		// No upscaling: the 9:16 crop of a 720p measures 405 px → comes out as 404×720 (even), not 720×1280.
		expect(dimsOf(`${workdir}/mp4/vertical-720p.mp4`)).toBe("404,720");
		expect(audioStreamsOf(`${workdir}/mp4/main-720p.mp4`)).toBe("");

		// +faststart: the `moov` atom comes before `mdat`.
		const mp4 = readFileSync(`${workdir}/mp4/main-720p.mp4`).toString("latin1");
		expect(mp4.indexOf("moov")).toBeLessThan(mp4.indexOf("mdat"));

		const master = readFileSync(`${workdir}/output/playlist.m3u8`, "utf8");
		expect(master).toContain("RESOLUTION=640x360");
		expect(master).toContain("RESOLUTION=1280x720");
		// Audio stripped → video-only CODECS, at the level each rung was really encoded with.
		expect(master).toContain('RESOLUTION=640x360,CODECS="avc1.64001f"');
		expect(master).toContain('RESOLUTION=1280x720,CODECS="avc1.640020"');
		expect(master).not.toContain("mp4a");
		expect(master).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
		expect(h264ProfileLevelOf(`${workdir}/output/720p_000.ts`)).toBe("High,32");
		expect(h264ProfileLevelOf(`${workdir}/output/360p_000.ts`)).toBe("High,31");

		expect(dimsOf(`${workdir}/poster.jpg`)).toBe("1280,720");
		expect(dimsOf(`${workdir}/thumbnail.jpg`)).toBe("640,360");
	});

	it("keep audio: the MP4 carries AAC and HAS_AUDIO=true", () => {
		rmSync(`${workdir}/mp4`, { recursive: true, force: true });
		const result = runPlan(workdir, { mp4: { rungs: ["360p"] }, poster: { at: "first" } });
		expect(result).toMatch(/^RESULT 1\|360\|true\|/);
		expect(audioStreamsOf(`${workdir}/mp4/main-360p.mp4`)).not.toBe("");
		expect(existsSync(`${workdir}/poster.jpg`)).toBe(true);
	});

	it("9:16 of a 1080p source requesting 1080p → 608×1080 at the crop's size (short side 608)", () => {
		execFileSync("ffmpeg", [
			...["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=1920x1080:rate=30"],
			...["-c:v", "libx264", "-preset", "ultrafast", "-f", "mp4", `${workdir}/input`],
		]);
		rmSync(`${workdir}/mp4`, { recursive: true, force: true });
		rmSync(`${workdir}/output`, { recursive: true, force: true });
		const result = runPlan(workdir, {
			crop: "9:16-center",
			hls: { rungs: ["1080p"] },
			variants: [{ name: "vertical", crop: "9:16-center", mp4: { rungs: ["1080p"] } }],
		});
		expect(result).toMatch(/^RESULT 2\|608\|/);
		expect(dimsOf(`${workdir}/mp4/vertical-1080p.mp4`)).toBe("608,1080");
		// Both outputs came out at 608 on the short side.
		expect(shortSides(result)).toEqual([608, 608]);
		expect(readFileSync(`${workdir}/output/playlist.m3u8`, "utf8")).toContain("RESOLUTION=608x1080");
		expect(dimsOf(`${workdir}/poster.jpg`)).toBe("608,1080");
	});

	it("per-title + storyboard: a simple 30 s clip lowers the cap; the probe costs ≤ 10% of the encode", () => {
		synthesize(`${workdir}/input`, "testsrc=size=1280x720:rate=30:duration=30");
		for (const dir of ["mp4", "output", "storyboard"]) rmSync(`${workdir}/${dir}`, { recursive: true, force: true });
		runPlan(workdir, { hls: { rungs: ["360p", "720p"] } });
		const perTitle = lastPerTitle();
		console.log(
			`[smoke] simple: score ${perTitle.score}, probe ${perTitle.probeSeconds.toFixed(2)} s vs encode ${perTitle.encodeSeconds.toFixed(2)} s (${((perTitle.probeSeconds / perTitle.encodeSeconds) * 100).toFixed(1)}%), 720p crf ${perTitle.crf720} maxrate ${perTitle.maxrate720}k`,
		);
		expect(Number(perTitle.score)).toBeLessThan(0.5);
		expect(perTitle.maxrate720).toBeLessThan(3000);
		expect(perTitle.crf720).toBeGreaterThan(23);
		// Target ≤ ~10% (measured 4–9% here); margin for loaded machines, the log shows the real number.
		expect(perTitle.probeSeconds / perTitle.encodeSeconds).toBeLessThanOrEqual(0.15);

		// Storyboard: 15 thumbnails (every 2 s) at 160×90 on a 10×10 sheet, with the VTT pointing at their crops.
		expect(perTitle.storyboardKey).toBe("public/video/v1/storyboard/storyboard.vtt");
		expect(dimsOf(`${workdir}/storyboard/sprite-0.jpg`)).toBe("1600,900");
		expect(existsSync(`${workdir}/storyboard/sprite-1.jpg`)).toBe(false);
		const vtt = readFileSync(`${workdir}/storyboard/storyboard.vtt`, "utf8");
		const cues = vtt.split("\n\n").slice(1);
		expect(cues).toHaveLength(15);
		expect(cues[11]).toBe("00:00:22.000 --> 00:00:24.000\nsprite-0.jpg#xywh=160,90,160,90");
	}, 120_000);

	it("per-title: noise (complex content) keeps the ladder's caps", () => {
		synthesize(`${workdir}/input`, "nullsrc=size=640x360:rate=30:duration=12,geq=random(1)*255:128:128,format=yuv420p");
		for (const dir of ["mp4", "output", "storyboard"]) rmSync(`${workdir}/${dir}`, { recursive: true, force: true });
		runPlan(workdir, { mp4: { rungs: ["720p"] }, storyboard: false });
		const perTitle = lastPerTitle();
		console.log(
			`[smoke] complex: score ${perTitle.score}, 720p crf ${perTitle.crf720} maxrate ${perTitle.maxrate720}k`,
		);
		expect(Number(perTitle.score)).toBe(1);
		expect(perTitle.crf720).toBe(23);
		expect(perTitle.maxrate720).toBe(3000);
		expect(perTitle.storyboardKey).toBe("");
	}, 120_000);
});
