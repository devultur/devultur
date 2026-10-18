/// <reference types="node" />

import { TRANSCODE_TEMPLATES } from "@devultur/core";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MaxResolution } from "../types";
import { planTranscode } from "./plan";
import { buildScript } from "./script";

const base = {
	videoId: "vid1",
	maxResolution: MaxResolution.P1080,
	outputPrefix: "public/video/vid1/hls/",
	thumbnailKey: "public/video/vid1/thumbnails/thumbnail.jpg",
	posterKey: "public/video/vid1/thumbnails/poster.jpg",
	mp4Prefix: "public/video/vid1/mp4/",
};

const heroScript = buildScript({
	...base,
	plan: planTranscode(TRANSCODE_TEMPLATES.hero, MaxResolution.P1080, { reportsOutputs: true }),
});

describe("buildScript with presets", () => {
	it("the full script is valid sh (hero and legacy)", () => {
		for (const script of [heroScript, buildScript(base)]) {
			expect(() => execFileSync("sh", ["-n", "-c", script])).not.toThrow();
		}
	});

	it("uploads MP4s to mp4/ and the poster to thumbnails/poster.jpg", () => {
		expect(heroScript).toContain('upload_asset "$f" "public/video/vid1/mp4/$FILENAME" "video/mp4"');
		expect(heroScript).toContain("upload_asset() {");
		expect(heroScript).toContain('"$WORKER_URL/v1/upload/public/video/vid1/thumbnails/poster.jpg"');
	});

	it("without an HLS ladder, doesn't write a master or announce a playlist", () => {
		expect(heroScript).toContain('if [ -n "$RENDITIONS" ]; then');
		expect(heroScript).toContain('[ -n "$RENDITIONS" ] || PLAYLIST_KEY=""');
		expect(heroScript).toContain('[ -e "$f" ] || continue');
	});

	it("reports outputs, renditions, poster and audio in transcode.complete", () => {
		const completion = heroScript.split("\n").find((line) => line.includes("transcode.complete")) ?? "";
		expect(completion).toContain('\\"renditions\\":[$OUTPUTS_JSON]');
		// The real size of each output is measured after the encode and goes into OUTPUTS_JSON.
		expect(heroScript.indexOf("done < /tmp/outputs.list")).toBeGreaterThan(heroScript.indexOf("wait $FFMPEG_PID"));
		expect(heroScript).toContain('\\"width\\":$O_W,\\"height\\":$O_H}');
		expect(completion).toContain('\\"posterKey\\":\\"public/video/vid1/thumbnails/poster.jpg\\"');
		expect(completion).toContain('\\"posterFormats\\":[\\"jpg\\",\\"avif\\"]');
		expect(completion).toContain('\\"hasAudio\\":$HAS_AUDIO');
	});

	it("aliases keep the same event as always (only adding `encode`, which the worker doesn't forward)", () => {
		const completion =
			buildScript(base)
				.split("\n")
				.find((line) => line.includes("transcode.complete")) ?? "";
		expect(completion).not.toContain("renditions");
		expect(completion).not.toContain("posterKey");
		expect(completion).toContain('\\"encode\\":{');
	});
});
