import { describe, expect, it } from "vitest";
import type { MaxResolution } from "../types";
import { buildScript } from "./script";

const options = {
	videoId: "abc123",
	maxResolution: "1080p" as MaxResolution,
	outputPrefix: "video/abc123/hls/",
	thumbnailKey: "video/abc123/thumbnails/thumbnail.jpg",
};

describe("buildScript — L4 HLS AES-128 encryption", () => {
	it("without encrypt: clean ladder, no keyinfo or -hls_key_info_file", () => {
		const script = buildScript(options);
		expect(script).not.toContain("-hls_key_info_file");
		expect(script).not.toContain("/tmp/enc.keyinfo");
	});

	it("with encrypt: writes keyfile+keyinfo and passes -hls_key_info_file to ffmpeg", () => {
		const script = buildScript({ ...options, encrypt: true });
		// keyfile from the base64 env and keyinfo with the relative URI (baked into the playlist).
		expect(script).toContain('echo "$KEY_B64" | base64 -d > /tmp/enc.keyfile');
		expect(script).toContain('"$KEY_ID.key"');
		expect(script).toContain("-hls_key_info_file /tmp/enc.keyinfo");
		// The keyfile lives outside /tmp/output → it isn't uploaded to R2 with the segments.
		expect(script).not.toContain("/tmp/output/enc.keyfile");
	});

	it("downloads the raw with the DOWNLOAD_TOKEN (not the upload credential): the gate requires a viewer token for private media", () => {
		const script = buildScript(options);
		expect(script).toContain(
			'curl -sS -o /tmp/input "$WORKER_URL/v1/media/$INPUT_KEY" -H "Authorization: Bearer $DOWNLOAD_TOKEN"',
		);
		// The upload credential is still used for segment UPLOADS (not for the input download).
		expect(script).toContain('curl -sS -X PUT "$WORKER_URL/v1/upload/');
	});

	it("uploads the thumbnail to its own path (thumbnails/), generated OUTSIDE /tmp/output", () => {
		const script = buildScript(options);
		// Generated outside the hls/ folder (which the segment loop sweeps).
		expect(script).toContain("/tmp/thumbnail.jpg");
		expect(script).not.toContain("/tmp/output/thumbnail.jpg");
		// Uploaded to THUMBNAIL_KEY (thumbnails/), not to the outputPrefix's hls/ folder.
		expect(script).toContain(`"$WORKER_URL/v1/upload/${options.thumbnailKey}"`);
	});

	it("propagates the binding override (RESOURCE_SECURITY) as a header on derived uploads", () => {
		const script = buildScript(options);
		expect(script).toContain('-H "X-Devultur-Resource-Security: $RESOURCE_SECURITY"');
	});
});

describe("buildScript — transcode.failed emission", () => {
	const script = buildScript(options);

	it("installs an EXIT trap that emits transcode.failed", () => {
		expect(script).toContain("trap notify_failure EXIT");
		expect(script).toContain('\\"event\\":\\"transcode.failed\\"');
		expect(script).toContain('\\"videoId\\":\\"abc123\\"');
	});

	it("guards the failure notification against success", () => {
		// doesn't fire on exit 0 or after completing (COMPLETED)
		expect(script).toContain('[ "$ec" -eq 0 ] && return 0');
		expect(script).toContain('[ -n "$COMPLETED" ] && return 0');
		// COMPLETED is only set after the success event
		const completeIndex = script.indexOf('\\"event\\":\\"transcode.complete\\"');
		const flagIndex = script.indexOf("COMPLETED=1");
		expect(completeIndex).toBeGreaterThan(-1);
		expect(flagIndex).toBeGreaterThan(completeIndex);
	});

	it("tracks the failing stage for a useful error", () => {
		for (const stage of ["STAGE=downloading", "STAGE=encoding", "STAGE=thumbnail", "STAGE=uploading"]) {
			expect(script).toContain(stage);
		}
		expect(script).toContain("at $STAGE (exit $ec)");
	});

	it("still emits the happy-path events", () => {
		expect(script).toContain('\\"event\\":\\"transcode.started\\"');
		expect(script).toContain('\\"event\\":\\"transcode.complete\\"');
	});

	it("categorizes the failure with reason + retriable per stage", () => {
		// stage → (reason, retriable) map inside the trap's case
		expect(script).toContain("downloading) R=invalid_input; T=false");
		expect(script).toContain("encoding) R=unsupported_codec; T=false");
		expect(script).toContain("starting) R=capacity; T=true");
		expect(script).toContain("*) R=internal; T=true");
		// the failure event includes reason (string) and retriable (unquoted bool)
		expect(script).toContain('\\"reason\\":\\"$R\\"');
		expect(script).toContain('\\"retriable\\":$T');
	});

	it("emits an early downloading heartbeat before the input download", () => {
		const heartbeatIndex = script.indexOf('\\"phase\\":\\"downloading\\"');
		const downloadIndex = script.indexOf("curl -sS -o /tmp/input");
		expect(heartbeatIndex).toBeGreaterThan(-1);
		expect(downloadIndex).toBeGreaterThan(heartbeatIndex); // the heartbeat happens BEFORE downloading
	});

	it("retries transcode.complete (terminal event) and treats a non-2xx as a failure", () => {
		const script = buildScript(options);
		const completionLine = script.split("\n").find((line) => line.includes("transcode.complete"));
		expect(completionLine).toContain("--fail --retry 5");
	});
});

describe("buildScript — HLS ladder (real bitrate, aligned GOP, short side)", () => {
	const script = buildScript(options);

	it("each rendition carries a bitrate cap, 2 s GOP and 2 s segments", () => {
		const ffmpegArgs = script.split("\n").filter((line) => line.startsWith('  FF_OUTPUTS="$FF_OUTPUTS'));
		expect(ffmpegArgs.length).toBeGreaterThan(0);
		for (const args of ffmpegArgs) {
			// Per-title (default): the rung's cap comes from the `PT_*` variables the complexity probe sets.
			expect(args).toMatch(/-maxrate \$\{PT_MAXRATE_\w+\}k -bufsize \$\{PT_BUFSIZE_\w+\}k/);
			expect(args).toContain("-force_key_frames expr:gte(t,n_forced*2) -sc_threshold 0");
			expect(args).toContain("-hls_time 2 ");
			// Scaled by short side, or to the source size (even) if no rung fits: never upscaling.
			expect(args).toMatch(/force_original_aspect_ratio=increase|scale=trunc\(iw\/2\)\*2:trunc\(ih\/2\)\*2/);
		}
	});

	it("picks the ladder by the source's short side (width and height)", () => {
		expect(script).toContain("-show_entries stream=width,height");
		expect(script).toContain("V_SHORT=$SRC_SHORT");
		expect(script).toContain('if [ "$V_SHORT" -ge 1080 ]; then');
	});

	it("expands FF_OUTPUTS with noglob (the keyframe expr carries `*`)", () => {
		const ffmpegIndex = script.indexOf("ffmpeg -nostdin -progress");
		expect(script.lastIndexOf("set -f", ffmpegIndex)).toBeGreaterThan(-1);
		expect(script.indexOf("set +f", ffmpegIndex)).toBeGreaterThan(ffmpegIndex);
	});

	it("writes the master AFTER the encode with measured BANDWIDTH, not constant", () => {
		const waitIndex = script.indexOf("wait $FFMPEG_PID");
		const masterIndex = script.indexOf('printf "%b" "$MASTER" > /tmp/output/playlist.m3u8');
		expect(masterIndex).toBeGreaterThan(waitIndex);
		expect(script).not.toMatch(/BANDWIDTH=\d/);
		expect(script).toContain('printf "BANDWIDTH=%d,AVERAGE-BANDWIDTH=%d');
		expect(script).toContain("#EXT-X-STREAM-INF:$RATES,RESOLUTION=$RESOLUTION");
	});
});

describe("buildScript — encode measurement", () => {
	const script = buildScript(options);

	it("measures only the ladder's ffmpeg (wall clock)", () => {
		const startIndex = script.indexOf("ENCODE_START=$(date +%s)");
		const ffmpegIndex = script.indexOf("ffmpeg -nostdin -progress");
		const waitIndex = script.indexOf("wait $FFMPEG_PID");
		const endIndex = script.indexOf("ENCODE_SECONDS=$(( $(date +%s) - ENCODE_START ))");
		expect(startIndex).toBeGreaterThan(-1);
		expect(startIndex).toBeLessThan(ffmpegIndex);
		expect(endIndex).toBeGreaterThan(waitIndex);
	});

	it("reports the encode measurement (seconds, cpus, topRung, runner) in transcode.complete", () => {
		const completionLine = script.split("\n").find((line) => line.includes("transcode.complete")) ?? "";
		expect(completionLine).toContain('\\"encode\\":{\\"seconds\\":$ENCODE_SECONDS');
		expect(completionLine).toContain('\\"cpus\\":$TRANSCODE_CPUS');
		expect(completionLine).toContain('\\"topRung\\":\\"$TOP_RES\\"');
		expect(completionLine).toContain('\\"runner\\":\\"$TRANSCODE_RUNNER\\"');
	});

	it("sanea cpus/runner antes de meterlos crudos al JSON", () => {
		expect(script).toContain('case "$TRANSCODE_CPUS" in ""|*[!0-9]*) TRANSCODE_CPUS=0 ;; esac');
		expect(script).toContain('case "$TRANSCODE_RUNNER" in ""|*[!a-z0-9-]*) TRANSCODE_RUNNER=unknown ;; esac');
	});
});
