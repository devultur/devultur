/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ladderSetupScript } from "./transcode/plan-script";
import {
	masterPlaylistScript,
	presetToMaxResolution,
	RENDITION_LADDER,
	renditionArgs,
	renditionsFor,
	scaleFilter,
	videoCodecOf,
} from "./transcode-ladder";
import { MaxResolution } from "./types";

describe("renditionsFor", () => {
	it("cap 720p → 360p + 720p", () => {
		expect(renditionsFor(MaxResolution.P720).map((r) => r.name)).toEqual(["360p", "720p"]);
	});

	it("cap 1080p → 360p + 720p + 1080p", () => {
		expect(renditionsFor(MaxResolution.P1080).map((r) => r.name)).toEqual(["360p", "720p", "1080p"]);
	});

	it("cap 4k → the whole ladder", () => {
		expect(renditionsFor(MaxResolution.P4K).map((r) => r.name)).toEqual(["360p", "720p", "1080p", "4k"]);
	});

	it("never includes renditions above the cap (short side)", () => {
		for (const r of renditionsFor(MaxResolution.P720)) expect(r.shortSide).toBeLessThanOrEqual(720);
		for (const r of renditionsFor(MaxResolution.P1080)) expect(r.shortSide).toBeLessThanOrEqual(1080);
	});

	it("is always adaptive (includes the lowest rendition)", () => {
		expect(renditionsFor(MaxResolution.P720)[0]?.name).toBe("360p");
		expect(renditionsFor(MaxResolution.P4K)[0]?.name).toBe("360p");
	});
});

describe("presetToMaxResolution (self-host fallback)", () => {
	it("hls-adaptive → 1080p", () => {
		expect(presetToMaxResolution("hls-adaptive")).toBe(MaxResolution.P1080);
	});

	it("hls-720p and anything else → 720p", () => {
		expect(presetToMaxResolution("hls-720p")).toBe(MaxResolution.P720);
		expect(presetToMaxResolution("whatever")).toBe(MaxResolution.P720);
	});
});

describe("RENDITION_LADDER", () => {
	it("is sorted ascending by short side and by bitrate cap", () => {
		const shortSides = RENDITION_LADDER.map((r) => r.shortSide);
		const maxrates = RENDITION_LADDER.map((r) => r.maxrateKbps);
		expect(shortSides).toEqual([...shortSides].sort((a, b) => a - b));
		expect(maxrates).toEqual([...maxrates].sort((a, b) => a - b));
	});
});

describe("renditionArgs", () => {
	const rendition = RENDITION_LADDER[2];

	it("CRF with a cap: -maxrate and -bufsize = 2×maxrate", () => {
		expect(renditionArgs(rendition, "")).toContain("-crf 20 -maxrate 6000k -bufsize 12000k");
	});

	it("fixed 2s GOP aligned across renditions + 2s segments", () => {
		const args = renditionArgs(rendition, "");
		expect(args).toContain("-force_key_frames expr:gte(t,n_forced*2) -sc_threshold 0");
		expect(args).toContain("-pix_fmt yuv420p");
		expect(args).toContain("-hls_time 2 -hls_playlist_type vod");
		expect(args).toContain("-hls_segment_filename /tmp/output/1080p_%03d.ts /tmp/output/1080p.m3u8");
	});

	it("scales by short side (works for vertical and horizontal), no commas or spaces in the filter", () => {
		expect(scaleFilter(rendition)).toBe("scale=1080:1080:force_original_aspect_ratio=increase:force_divisible_by=2");
		expect(scaleFilter(rendition)).not.toMatch(/[\s,']/);
		expect(renditionArgs(rendition, "")).not.toContain("scale=-2:");
	});

	it("respects the encryption option before -hls_time", () => {
		expect(renditionArgs(rendition, "-hls_key_info_file /tmp/enc.keyinfo ")).toContain(
			"-f hls -hls_key_info_file /tmp/enc.keyinfo -hls_time 2",
		);
	});

	it("outputs a probe frame outside /tmp/output (not uploaded)", () => {
		expect(renditionArgs(rendition, "")).toContain("-frames:v 1");
		expect(renditionArgs(rendition, "")).toContain("/tmp/probe/1080p.jpg");
	});
});

// Runs the generated shell with a fake `ffprobe` that reports the source's dims.
function runLadder(maxResolution: MaxResolution, dims: string): { renditions: string[]; topShortSide: number } {
	const stub = `ffprobe() { echo "${dims}"; }`;
	const script = [stub, ladderSetupScript(maxResolution, ""), 'echo "$RENDITIONS|$TOP_SHORT"'].join("\n");
	const output = execFileSync("sh", ["-c", script], { encoding: "utf8" }).trim().split("\n").at(-1) ?? "";
	const [renditions = "", topShortSide = ""] = output.split("|");
	return { renditions: renditions.trim().split(/\s+/), topShortSide: Number(topShortSide) };
}

describe("ladderSetupScript (runtime selection by short side)", () => {
	it("horizontal 1920×1080 → up to 1080p, short side 1080", () => {
		expect(runLadder(MaxResolution.P4K, "1920,1080")).toEqual({
			renditions: ["360p", "720p", "1080p"],
			topShortSide: 1080,
		});
	});

	it("vertical 1080×1920 → up to 1080p (not 4k), short side 1080", () => {
		expect(runLadder(MaxResolution.P4K, "1080,1920")).toEqual({
			renditions: ["360p", "720p", "1080p"],
			topShortSide: 1080,
		});
	});

	it("square 1080×1080 → up to 1080p", () => {
		expect(runLadder(MaxResolution.P4K, "1080,1080").renditions).toEqual(["360p", "720p", "1080p"]);
	});

	it("vertical 4K (2160×3840) with 4k cap → short side 2160", () => {
		expect(runLadder(MaxResolution.P4K, "2160,3840")).toEqual({
			renditions: ["360p", "720p", "1080p", "4k"],
			topShortSide: 2160,
		});
	});

	it("never upscales: vertical 720×1280 with 4k cap → up to 720p", () => {
		expect(runLadder(MaxResolution.P4K, "720,1280")).toEqual({ renditions: ["360p", "720p"], topShortSide: 720 });
	});

	it("respects the cap: 1080×1920 with 720p cap → up to 720p", () => {
		expect(runLadder(MaxResolution.P720, "1080,1920").renditions).toEqual(["360p", "720p"]);
	});

	it("source smaller than the lowest rendition (or no dims) → still generates 360p", () => {
		expect(runLadder(MaxResolution.P4K, "320,240").renditions).toEqual(["360p"]);
		expect(runLadder(MaxResolution.P4K, "").renditions).toEqual(["360p"]);
	});
});

describe("masterPlaylistScript (BANDWIDTH measured from the output)", () => {
	let workdir = "";

	afterEach(() => {
		if (workdir) rmSync(workdir, { recursive: true, force: true });
	});

	it("BANDWIDTH = per-segment peak, AVERAGE-BANDWIDTH = average, RESOLUTION from the probe frame", () => {
		workdir = mkdtempSync(`${tmpdir()}/master-`);
		const playlist = [
			"#EXTM3U",
			"#EXT-X-TARGETDURATION:2",
			"#EXTINF:2.000000,",
			"1080p_000.ts",
			"#EXTINF:2.000000,",
			"1080p_001.ts",
			"#EXTINF:1.000000,",
			"1080p_002.ts",
			"#EXT-X-ENDLIST",
		].join("\n");
		writeFileSync(`${workdir}/1080p.m3u8`, playlist);
		// 2s → 1 Mbps · 2s → 2 Mbps (peak) · 1s → 1 Mbps. Total 7 Mbit / 5s = 1.4 Mbps.
		writeFileSync(`${workdir}/1080p_000.ts`, "x".repeat(250_000));
		writeFileSync(`${workdir}/1080p_001.ts`, "x".repeat(500_000));
		writeFileSync(`${workdir}/1080p_002.ts`, "x".repeat(125_000));

		const masterWith = (hasAudio: boolean) => {
			const script = [
				'ffprobe() { echo "1080x1920"; }',
				"RENDITIONS=' 1080p'",
				`HAS_AUDIO=${hasAudio}`,
				masterPlaylistScript().replaceAll("/tmp/output", workdir).replaceAll("/tmp/probe", workdir),
			].join("\n");
			execFileSync("sh", ["-c", script], { encoding: "utf8" });
			return readFileSync(`${workdir}/playlist.m3u8`, "utf8");
		};

		const head = "#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n";
		const info = "#EXT-X-STREAM-INF:BANDWIDTH=2000001,AVERAGE-BANDWIDTH=1400001,RESOLUTION=1080x1920";
		expect(masterWith(true)).toBe(`${head}${info},CODECS="avc1.64002a,mp4a.40.2"\n1080p.m3u8\n`);
		expect(masterWith(false)).toBe(`${head}${info},CODECS="avc1.64002a"\n1080p.m3u8\n`);
	});

	it("encodes every rung at H.264 High with the level its CODECS declares", () => {
		for (const rendition of RENDITION_LADDER) {
			const args = renditionArgs(rendition, "");
			expect(args).toContain(`-profile:v high -level:v ${rendition.h264Level}`);
			expect(videoCodecOf(rendition)).toBe(
				`avc1.6400${Math.round(Number(rendition.h264Level) * 10)
					.toString(16)
					.padStart(2, "0")}`,
			);
		}
		expect(RENDITION_LADDER.map(videoCodecOf)).toEqual(["avc1.64001f", "avc1.640020", "avc1.64002a", "avc1.640034"]);
	});

	it("has no hard-coded BANDWIDTH in the script", () => {
		expect(masterPlaylistScript()).not.toMatch(/BANDWIDTH=\d/);
		expect(ladderSetupScript(MaxResolution.P4K, "")).not.toContain("BANDWIDTH");
	});
});
