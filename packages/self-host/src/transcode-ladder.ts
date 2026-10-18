import type { TranscodeCrop } from "@devultur/core";
import { MaxResolution } from "./types";

// Rendition ladder (ascending). Each rung is defined by the video's SHORT SIDE (360/720/1080/2160):
// a vertical 1080×1920 is "1080p" just like a horizontal 1920×1080. The resolution cap trims which
// ones get generated, and the source trims the ones that would be above its own short side (no upscaling).
//
// CRF with a cap (`-maxrate` + `-bufsize` = 2×maxrate): raw CRF has no ceiling, and a dense clip at CRF 20
// can go above 8 Mbps, which hls.js can't sustain even if the master advertises less. The caps follow the
// reference ladders (Apple HLS authoring spec / YouTube) for H.264 at 30fps with some margin:
// 360p ~0.8 Mbps, 720p ~3 Mbps, 1080p ~6 Mbps, 4k ~16 Mbps. "Normal" content stays below that and is
// still governed by the CRF; the cap only trims the peaks. The master's BANDWIDTH is measured from the real output.
//
// H.264 High at a fixed level per rung (with headroom for 60fps), so the master can declare the exact `CODECS`
// (`avc1.64` + level in hex) even when the segments are encrypted and can't be probed. Without `-level` x264
// picks one per encode, and the master couldn't know it.
export const RENDITION_LADDER = [
	{ name: "360p", shortSide: 360, crf: 28, audioBitrate: "96k", maxrateKbps: 800, h264Level: "3.1" },
	{ name: "720p", shortSide: 720, crf: 23, audioBitrate: "128k", maxrateKbps: 3000, h264Level: "3.2" },
	{ name: "1080p", shortSide: 1080, crf: 20, audioBitrate: "192k", maxrateKbps: 6000, h264Level: "4.2" },
	{ name: "4k", shortSide: 2160, crf: 18, audioBitrate: "256k", maxrateKbps: 16000, h264Level: "5.2" },
] as const;

/** RFC 6381 codec of a rung's video: H.264 High (`64`), no constraint flags (`00`), level ×10 in hex. */
export function videoCodecOf(rendition: Rendition): string {
	const levelHex = Math.round(Number(rendition.h264Level) * 10)
		.toString(16)
		.padStart(2, "0");
	return `avc1.6400${levelHex}`;
}

/** RFC 6381 codec of the AAC-LC audio every rung encodes. */
export const AUDIO_CODEC = "mp4a.40.2";

const h264Args = (rendition: Rendition) => `-profile:v high -level:v ${rendition.h264Level}`;

export type Rendition = (typeof RENDITION_LADDER)[number];

// Fixed 2s GOP, identical across all renditions → segments stay aligned and the player can
// switch quality at any boundary. `expr:` works at any fps (doesn't depend on -g).
export const SEGMENT_SECONDS = 2;

// Cap interpreted on the short side (a vertical 1080×1920 fits under the 1080p cap).
const MAX_RESOLUTION_SHORT_SIDE: Record<MaxResolution, number> = {
	[MaxResolution.P720]: 720,
	[MaxResolution.P1080]: 1080,
	[MaxResolution.P4K]: 2160,
};

// Renditions to generate for a cap: all with short side ≤ cap (always adaptive).
export function renditionsFor(maxResolution: MaxResolution): readonly Rendition[] {
	const cap = MAX_RESOLUTION_SHORT_SIDE[maxResolution];
	return RENDITION_LADDER.filter((rendition) => rendition.shortSide <= cap);
}

/** Ladder rendition by name (`360p`…`4k`). */
export function renditionByName(name: string): Rendition | undefined {
	return RENDITION_LADDER.find((rendition) => rendition.name === name);
}

/**
 * Requested rungs clamped to the resolution cap, in ascending order and deduped. If all of them are above the
 * cap, the highest allowed rung is used (requesting a 1080p MP4 with a 720p cap gives a 720p, not nothing).
 */
export function clampRungsToCap(names: readonly string[], maxResolution: MaxResolution): Rendition[] {
	const allowed = renditionsFor(maxResolution);
	const withinCap = allowed.filter((rendition) => names.includes(rendition.name));
	if (withinCap.length > 0) return withinCap;
	const highestAllowed = allowed[allowed.length - 1];
	return highestAllowed ? [highestAllowed] : [];
}

// Fallback with no cap in the config: derives the cap from the requested preset.
export function presetToMaxResolution(preset: string): MaxResolution {
	return preset === "hls-adaptive" ? MaxResolution.P1080 : MaxResolution.P720;
}

// Scales to short side = rung while keeping the aspect ratio: `increase` grows the R×R box until it covers
// it, so the short side lands at R and the long side stays proportional (even, via `force_divisible_by=2`).
// No commas or quotes → survives `$FF_OUTPUTS`'s word-splitting without escaping.
export function scaleFilter(rendition: Rendition): string {
	const side = rendition.shortSide;
	return `scale=${side}:${side}:force_original_aspect_ratio=increase:force_divisible_by=2`;
}

// Centered crop BEFORE scaling. `min(...)` covers sources narrower than the target (a 9:16 crop on a
// video that's already taller than 9:16 crops the height, not the width). The `min`'s commas are escaped
// (`\,`) for the filtergraph parser; no spaces or quotes → survives `$FF_OUTPUTS`'s word-splitting. It
// operates on the already-rotated frame (ffmpeg auto-rotates), so a phone's vertical video crops in its real orientation.
const CROP_FILTERS: Record<TranscodeCrop, string> = {
	"9:16-center": "crop=w=min(iw\\,ih*9/16):h=min(ih\\,iw*16/9)",
	"1:1-center": "crop=w=min(iw\\,ih):h=min(iw\\,ih)",
};

export function cropFilter(crop: TranscodeCrop): string {
	return CROP_FILTERS[crop];
}

// Source size (already cropped) rounded to even (yuv420p requires it): the output when the source doesn't
// reach any requested rung. Never upscales. No commas or spaces → survives `$FF_OUTPUTS`'s word-splitting.
export const SOURCE_SIZE_FILTER = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

/** `-vf` chain of a rendition: optional crop + scaling by short side (or to the source size). */
export function videoFilter(rendition: Rendition, crop?: TranscodeCrop, atSourceSize?: boolean): string {
	const scale = atSourceSize ? SOURCE_SIZE_FILTER : scaleFilter(rendition);
	return crop ? `${cropFilter(crop)},${scale}` : scale;
}

export interface RenditionOptions {
	crop?: TranscodeCrop;
	/** The source doesn't reach the rung: output at the source size (even), no upscaling. */
	atSourceSize?: boolean;
	/** No audio: no audio map or codec (`-an`), the output is video-only. */
	stripAudio?: boolean;
	/** Per-title encode CRF/maxrate: the rung's `PT_*` variables that `perTitleScript` leaves behind (per-title.ts). */
	perTitle?: boolean;
}

// CRF with the rung's cap: fixed (the ladder's own) or, with per-title encoding, the rung's `PT_*` variables
// that the script sets at runtime after the complexity probe. `${…}`: the attached `k` isn't part of the name.
function crfRateArgs(rendition: Rendition, perTitle: boolean | undefined): string {
	if (!perTitle) {
		return `-crf ${rendition.crf} -maxrate ${rendition.maxrateKbps}k -bufsize ${rendition.maxrateKbps * 2}k`;
	}
	const tag = rendition.name.toUpperCase();
	return `-crf $PT_CRF_${tag} -maxrate \${PT_MAXRATE_${tag}}k -bufsize \${PT_BUFSIZE_${tag}}k`;
}

function audioArgs(rendition: Rendition, stripAudio: boolean | undefined): string {
	return stripAudio ? "-an" : `-c:a aac -b:a ${rendition.audioBitrate}`;
}

function streamMaps(stripAudio: boolean | undefined): string {
	return stripAudio ? "-map 0:v" : "-map 0:v -map 0:a?";
}

// ffmpeg args of a rendition. `hlsKeyOption` = AES-128 encryption option (empty if not encrypted).
export function renditionArgs(rendition: Rendition, hlsKeyOption: string, options: RenditionOptions = {}): string {
	const segmentPattern = `/tmp/output/${rendition.name}_%03d.ts`;
	const filter = videoFilter(rendition, options.crop, options.atSourceSize);
	return [
		streamMaps(options.stripAudio),
		`-vf ${filter}`,
		`-c:v libx264 -preset fast ${h264Args(rendition)} ${crfRateArgs(rendition, options.perTitle)}`,
		// Always 8-bit 4:2:0: a 10-bit/4:2:2 source (iPhone HDR, cameras) would produce High10/High 4:2:2, which
		// almost no browser decodes.
		"-pix_fmt yuv420p",
		`-force_key_frames expr:gte(t,n_forced*${SEGMENT_SECONDS}) -sc_threshold 0`,
		audioArgs(rendition, options.stripAudio),
		`-f hls ${hlsKeyOption}-hls_time ${SEGMENT_SECONDS} -hls_playlist_type vod`,
		`-hls_segment_filename ${segmentPattern} /tmp/output/${rendition.name}.m3u8`,
		// A scaled frame outside /tmp/output (not uploaded): gives the master's real RESOLUTION even when the
		// segments are encrypted (ffprobe can't read an AES-128 .ts).
		`-map 0:v:0 -frames:v 1 -vf ${filter} -update 1 /tmp/probe/${rendition.name}.jpg`,
	].join(" ");
}

export interface Mp4Options extends RenditionOptions {
	/** Target bitrate (kbps). Absent → the rung's CRF with the same cap as HLS. */
	bitrateKbps?: number;
}

// Target bitrate in a SINGLE pass (ABR with a cap): a 1.5× `-maxrate` and a 2× buffer let the encoder spread
// bits across scenes without exceeding the peak. Two-pass would nail the average better but encodes twice and
// can't share the decode with the rest of the outputs (a single ffmpeg) → ~2× runner clock time per MP4.
function mp4RateArgs(rendition: Rendition, options: Mp4Options): string {
	const { bitrateKbps } = options;
	// No bitrate from the spec → CRF with a cap (per-title if the plan asks for it). With a bitrate, the spec wins.
	if (!bitrateKbps) return crfRateArgs(rendition, options.perTitle);
	return `-b:v ${bitrateKbps}k -maxrate ${Math.round(bitrateKbps * 1.5)}k -bufsize ${bitrateKbps * 2}k`;
}

/** Local MP4 file of a frame/rung (the name is the same as its R2 key). */
export function mp4FileName(variant: string, rendition: Rendition): string {
	return `${variant}-${rendition.name}.mp4`;
}

// Args of a progressive MP4: first video (+ first audio unless stripped), `+faststart` so the `moov` goes at
// the start and the browser can start playing without downloading the whole file.
export function mp4Args(variant: string, rendition: Rendition, options: Mp4Options = {}): string {
	return [
		options.stripAudio ? "-map 0:v:0" : "-map 0:v:0 -map 0:a:0?",
		`-vf ${videoFilter(rendition, options.crop, options.atSourceSize)}`,
		`-c:v libx264 -preset fast ${h264Args(rendition)} ${mp4RateArgs(rendition, options)}`,
		"-pix_fmt yuv420p",
		audioArgs(rendition, options.stripAudio),
		`-movflags +faststart /tmp/mp4/${mp4FileName(variant, rendition)}`,
	].join(" ");
}

// awk over a media playlist: each `#EXTINF:<dur>,` precedes its segment's name, whose size is read with
// `wc -c`. Prints the `BANDWIDTH=peak,AVERAGE-BANDWIDTH=average` attributes in bits/s, rounded up (never
// advertise less than reality). No segments → exit 1 (aborts the script via `set -e`).
const SEGMENT_RATES_AWK = [
	'/^#EXTINF:/ { sub(/^#EXTINF:/, ""); sub(/,.*/, ""); duration = $0 + 0; next }',
	'/^[^#]/ && duration > 0 { cmd = "wc -c < " dir "/" $0; cmd | getline bytes; close(cmd);',
	"bits = bytes * 8; total += bits; elapsed += duration; rate = bits / duration;",
	"if (rate > peak) peak = rate; duration = 0 }",
	'END { if (elapsed <= 0) exit 1; printf "BANDWIDTH=%d,AVERAGE-BANDWIDTH=%d\\n", peak + 1, total / elapsed + 1 }',
].join(" ");

// `case` from a rung name to its video codec, for the master's CODECS.
function videoCodecCase(): string {
	const branches = RENDITION_LADDER.map((rendition) => `${rendition.name}) VIDEO_CODEC=${videoCodecOf(rendition)} ;;`);
	return `  case "$NAME" in ${branches.join(" ")} esac`;
}

// Shell that writes the master playlist AFTER the encode, with numbers measured from the real output:
// BANDWIDTH = per-segment bitrate peak and AVERAGE-BANDWIDTH = total bits / total duration
// (RFC 8216 §4.3.4.2). RESOLUTION comes from the probe frame (the .ts files may be encrypted). CODECS is the
// rung's fixed H.264 level, plus AAC only when the output carries audio (`HAS_AUDIO`, set before this runs), as the
// Apple HLS authoring spec asks, so players pick a variant without probing it.
export function masterPlaylistScript(): string {
	return [
		'MASTER="#EXTM3U\\n#EXT-X-INDEPENDENT-SEGMENTS\\n"',
		"for NAME in $RENDITIONS; do",
		videoCodecCase(),
		`  CODECS="$VIDEO_CODEC"; if [ "$HAS_AUDIO" = true ]; then CODECS="$CODECS,${AUDIO_CODEC}"; fi`,
		`  RATES=$(awk -v dir=/tmp/output '${SEGMENT_RATES_AWK}' "/tmp/output/$NAME.m3u8")`,
		'  RESOLUTION=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "/tmp/probe/$NAME.jpg")',
		'  echo "[transcode] $NAME $RESOLUTION $RATES"',
		'  MASTER="$MASTER#EXT-X-STREAM-INF:$RATES,RESOLUTION=$RESOLUTION,CODECS=\\"$CODECS\\"\\n$NAME.m3u8\\n"',
		"done",
		'printf "%b" "$MASTER" > /tmp/output/playlist.m3u8',
	].join("\n");
}
