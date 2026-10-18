/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mp4Args, RENDITION_LADDER, renditionArgs } from "../transcode-ladder";
import { MaxResolution } from "../types";
import {
	complexityScore,
	crfRungs,
	encodeParamsJson,
	PER_TITLE,
	perTitleRate,
	perTitleScript,
	probeSampleCount,
} from "./per-title";
import { planTranscode } from "./plan";
import { planSetupScript } from "./plan-script";
import { buildScript } from "./script";

const [P360, P720, P1080, P4K] = RENDITION_LADDER;

describe("probeSampleCount", () => {
	it("no probe for short clips or invalid duration", () => {
		expect(probeSampleCount(9.9)).toBe(0);
		expect(probeSampleCount(Number.NaN)).toBe(0);
	});

	it("una muestra cada 15 s, entre 1 y 4", () => {
		expect(probeSampleCount(10)).toBe(1);
		expect(probeSampleCount(44)).toBe(2);
		expect(probeSampleCount(60)).toBe(4);
		expect(probeSampleCount(7200)).toBe(PER_TITLE.maxSamples);
	});
});

describe("complexityScore", () => {
	it("logarithmic scale from simple (≤100 kbps) to complex (≥800 kbps)", () => {
		expect(complexityScore(7)).toBe(0);
		expect(complexityScore(100)).toBe(0);
		expect(complexityScore(283)).toBe(0.5);
		expect(complexityScore(800)).toBe(1);
		expect(complexityScore(12_000)).toBe(1);
	});
});

describe("perTitleRate", () => {
	it("contenido simple: maxrate a la mitad del tope y CRF +2", () => {
		expect(perTitleRate(P1080, 0)).toEqual({ crf: 22, maxrateKbps: 3000 });
		expect(perTitleRate(P360, 0)).toEqual({ crf: 30, maxrateKbps: 400 });
	});

	it("complex content: the ladder's parameters, untouched", () => {
		expect(perTitleRate(P1080, 1)).toEqual({ crf: 20, maxrateKbps: 6000 });
		expect(perTitleRate(P4K, 1)).toEqual({ crf: 18, maxrateKbps: 16000 });
	});

	it("intermedio: entre ambos extremos", () => {
		expect(perTitleRate(P720, 0.5)).toEqual({ crf: 24, maxrateKbps: 2250 });
	});

	it("nunca pasa el tope ni baja el CRF base, para cualquier score", () => {
		for (const rendition of RENDITION_LADDER) {
			for (let step = 0; step <= 100; step++) {
				const { crf, maxrateKbps } = perTitleRate(rendition, step / 100);
				expect(maxrateKbps).toBeLessThanOrEqual(rendition.maxrateKbps);
				expect(maxrateKbps).toBeGreaterThanOrEqual(rendition.maxrateKbps * PER_TITLE.minMaxrateFactor);
				expect(crf).toBeGreaterThanOrEqual(rendition.crf);
				expect(crf).toBeLessThanOrEqual(rendition.crf + PER_TITLE.maxCrfBoost);
			}
		}
	});

	it("sin prueba (null) = la escalera", () => {
		expect(perTitleRate(P1080, null)).toEqual({ crf: 20, maxrateKbps: 6000 });
	});
});

describe("ffmpeg args with per-title encoding", () => {
	it("HLS and MP4 at CRF read the rung's PT_* variables", () => {
		const hls = renditionArgs(P1080, "", { perTitle: true });
		expect(hls).toContain(`-crf $PT_CRF_1080P -maxrate \${PT_MAXRATE_1080P}k -bufsize \${PT_BUFSIZE_1080P}k`);
		expect(mp4Args("main", P4K, { perTitle: true })).toContain("-crf $PT_CRF_4K");
	});

	it("an MP4 with a bitrate in the spec wins: fixed ABR, no per-title variables", () => {
		const args = mp4Args("main", P1080, { perTitle: true, bitrateKbps: 5000 });
		expect(args).toContain("-b:v 5000k -maxrate 7500k -bufsize 10000k");
		expect(args).not.toContain("PT_");
	});

	it("perTitle: false → fixed ladder args (identical to before)", () => {
		const plan = planTranscode({ hls: { rungs: ["1080p"] }, perTitle: false }, MaxResolution.P1080, {
			reportsOutputs: true,
		});
		const setup = planSetupScript(plan, "");
		expect(setup).toContain("-crf 20 -maxrate 6000k -bufsize 12000k");
		expect(setup).not.toContain("PT_");
	});

	it("reported parameters only cover the CRF rungs", () => {
		const plan = planTranscode(
			{ hls: { rungs: ["720p"] }, mp4: { rungs: ["1080p"], bitrate: { "1080p": 5000 } } },
			MaxResolution.P1080,
			{ reportsOutputs: true },
		);
		expect(crfRungs(plan).map((rendition) => rendition.name)).toEqual(["720p"]);
		expect(encodeParamsJson(plan)).toBe(
			'[{\\"rung\\":\\"720p\\",\\"crf\\":$PT_CRF_720P,\\"maxrateKbps\\":$PT_MAXRATE_720P}]',
		);
	});

	it("the job script probes BEFORE setup and reports complexity + parameters in transcode.complete", () => {
		const script = buildScript({
			videoId: "v1",
			maxResolution: MaxResolution.P1080,
			outputPrefix: "public/video/v1/hls/",
			thumbnailKey: "public/video/v1/thumbnails/thumbnail.jpg",
		});
		expect(script.indexOf("PROBE_SAMPLES=")).toBeLessThan(script.indexOf('FF_OUTPUTS=""'));
		expect(script).toContain('\\"complexity\\":$PT_SCORE');
		expect(script).toContain('\\"probeSeconds\\":$PROBE_SECONDS');
		expect(script).toContain('\\"params\\":[');
	});
});

// Runs the real probe shell with a fake `ffmpeg` that writes as many bytes as FAKE_PROBE_BYTES asks for per
// sample: verifies that the runner's awk computes the same as the TS functions.
describe("perTitleScript (shell)", () => {
	let workdir = "";

	beforeAll(() => {
		workdir = mkdtempSync(`${tmpdir()}/devultur-pertitle-`);
		mkdirSync(`${workdir}/bin`);
		mkdirSync(`${workdir}/probe`);
		const fakeFfmpeg = '#!/bin/sh\nfor last; do :; done\nhead -c "$FAKE_PROBE_BYTES" /dev/zero > "$last"\n';
		writeFileSync(`${workdir}/bin/ffmpeg`, fakeFfmpeg);
		chmodSync(`${workdir}/bin/ffmpeg`, 0o755);
	});

	afterAll(() => {
		if (workdir) rmSync(workdir, { recursive: true, force: true });
	});

	function runProbe(durationSeconds: number, bytesPerSample: number, perTitle = true) {
		const plan = planTranscode({ hls: {}, perTitle }, MaxResolution.P4K, { reportsOutputs: true });
		const script = [
			`DURATION=${durationSeconds}`,
			perTitleScript(plan),
			'echo "RESULT $PT_SCORE|$PROBE_SAMPLES|$PT_CRF_1080P|$PT_MAXRATE_1080P|$PT_BUFSIZE_1080P|$PT_MAXRATE_360P"',
		]
			.join("\n")
			.replaceAll("/tmp/", `${workdir}/`);
		const output = execFileSync("sh", ["-c", script], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${workdir}/bin:${process.env.PATH}`, FAKE_PROBE_BYTES: String(bytesPerSample) },
		});
		return output.split("\n").find((line) => line.startsWith("RESULT ")) ?? "";
	}

	it("simple content (≈60 kbps): CRF +2 and maxrate at half", () => {
		// 2 s at 60 kbps = 15000 bytes per sample.
		expect(runProbe(60, 15_000)).toBe("RESULT 0.00|4|22|3000|6000|400");
	});

	it("complex content (≈2 Mbps): the ladder's parameters", () => {
		expect(runProbe(60, 500_000)).toBe("RESULT 1.00|4|20|6000|12000|800");
	});

	it("intermedio: el shell coincide con perTitleRate", () => {
		const kbps = 300;
		const score = complexityScore(kbps);
		const expected1080 = perTitleRate(P1080, score);
		const expected360 = perTitleRate(P360, score);
		const result = runProbe(30, (kbps * 1000 * 2) / 8);
		expect(result).toBe(
			`RESULT ${score.toFixed(2)}|2|${expected1080.crf}|${expected1080.maxrateKbps}|${expected1080.maxrateKbps * 2}|${expected360.maxrateKbps}`,
		);
	});

	it("short clip or perTitle: false → no probe, base parameters", () => {
		expect(runProbe(5, 15_000)).toBe("RESULT null|0|20|6000|12000|800");
		expect(runProbe(60, 15_000, false)).toBe("RESULT null||20|6000|12000|800");
	});
});
