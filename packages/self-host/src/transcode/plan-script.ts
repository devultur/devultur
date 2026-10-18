// Shell that assembles the ffmpeg outputs at RUNTIME based on the source's resolution (no upscaling). It leaves:
//   FF_OUTPUTS     ffmpeg args for all outputs (a single input decode for all of them)
//   RENDITIONS     HLS ladder names (for the master playlist)
//   TOP_RES        highest rung generated across the whole job; TOP_SHORT its REAL short side
//   /tmp/outputs.list  one line per output (each HLS ladder = 1, by its highest rung; each MP4 = 1): the file
//                  whose real size is measured and its `{variant,kind,rung,key` (renditionsScript closes the JSON)
//   POSTER_SHORT   short side of the highest rung of the first frame (poster resolution)
//   SB_INTERVAL    seconds between storyboard thumbnails (if the plan asks for it)
import { cropFilter, mp4Args, mp4FileName, type Rendition, renditionArgs } from "../transcode-ladder";
import type { MaxResolution } from "../types";
import { legacyPlan, type PlannedVariant, type TranscodePlan } from "./plan";
import { storyboardOutputScript } from "./storyboard-script";

export interface OutputKeys {
	/** Master playlist key (`{vis}/video/{id}/hls/playlist.m3u8`). */
	playlistKey: string;
	/** MP4 prefix (`{vis}/video/{id}/mp4/`). */
	mp4Prefix: string;
}

const NO_KEYS: OutputKeys = { playlistKey: "", mp4Prefix: "" };

// Frame dims (`W,H`) → `<prefix>_SHORT`, sanitized to an integer (empty/odd = 0).
function shortSideScript(prefix: string, dimsCommand: string): string[] {
	return [
		`${prefix}_DIMS=$(${dimsCommand} | head -1)`,
		`${prefix}_W=$(echo "$${prefix}_DIMS" | cut -s -d, -f1)`,
		`${prefix}_H=$(echo "$${prefix}_DIMS" | cut -s -d, -f2)`,
		`case "$${prefix}_W" in ""|*[!0-9]*) ${prefix}_W=0 ;; esac`,
		`case "$${prefix}_H" in ""|*[!0-9]*) ${prefix}_H=0 ;; esac`,
		`${prefix}_SHORT=$${prefix}_W`,
		`if [ "$${prefix}_H" -lt "$${prefix}_SHORT" ]; then ${prefix}_SHORT=$${prefix}_H; fi`,
	];
}

const FRAME_DIMS = (file: string) =>
	`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 ${file}`;

// Short side of the frame: no crop = the source's; with a crop = that of a cropped frame (ffmpeg auto-rotates
// the frame, so a vertical phone video is measured in its real orientation).
function variantShortSide(variant: PlannedVariant): string[] {
	if (!variant.crop) return ["V_SHORT=$SRC_SHORT"];
	const probe = `/tmp/probe/crop-${variant.name}.jpg`;
	return [
		`ffmpeg -nostdin -v error -y -i /tmp/input -frames:v 1 -vf "${cropFilter(variant.crop)}" -update 1 ${probe}`,
		...shortSideScript("CROP", FRAME_DIMS(probe)),
		"V_SHORT=$CROP_SHORT",
	];
}

// Records a generated output with its REAL short side: job cap (resolution class) and frame cap
// (poster resolution). At source size, the short side is the source's (even), not the rung's.
function markRung(rendition: Rendition, atSourceSize: boolean): string[] {
	const side = atSourceSize ? "$V_EVEN" : String(rendition.shortSide);
	return [
		`  if [ ${side} -gt "$TOP_SHORT" ]; then TOP_SHORT=${side}; TOP_RES="${rendition.name}"; fi`,
		`  if [ ${side} -gt "$V_TOP" ]; then V_TOP=${side}; fi`,
	];
}

// Records an output: the file whose real size is measured (a frame of its rung or the MP4) and the start of its JSON.
const RECORD_RENDITION_FUNCTION = 'record_rendition() { echo "$1 $2" >> /tmp/outputs.list; }';

function recordRendition(probeFile: string, variant: string, kind: "hls" | "mp4", rung: string, key: string): string {
	const json = `{\\"variant\\":\\"${variant}\\",\\"kind\\":\\"${kind}\\",\\"rung\\":\\"${rung}\\",\\"key\\":\\"${key}\\"`;
	return `record_rendition "${probeFile}" "${json}"`;
}

type RungBlock = (rendition: Rendition, atSourceSize: boolean) => string[];

// Per-rung blocks cut off by the source: a rung qualifies if the frame reaches it. If none qualify, ONE output
// at source size (tagged with the lowest requested rung): never upscaling, never without an output.
function rungBlocks(rungs: readonly Rendition[], doneFlag: string, block: RungBlock) {
	const lowest = rungs[0];
	if (!lowest) return [];
	return [
		`${doneFlag}=""`,
		...rungs.flatMap((rendition) => [
			`if [ "$V_SHORT" -ge ${rendition.shortSide} ]; then`,
			...block(rendition, false),
			`  ${doneFlag}=1`,
			"fi",
		]),
		`if [ -z "$${doneFlag}" ]; then`,
		...block(lowest, true),
		"fi",
	];
}

function hlsScript(variant: PlannedVariant, plan: TranscodePlan, hlsKeyOption: string, keys: OutputKeys) {
	if (variant.hls.length === 0) return [];
	return [
		'HLS_TOP=""',
		...rungBlocks(variant.hls, "HLS_DONE", (rendition, atSourceSize) => [
			`  FF_OUTPUTS="$FF_OUTPUTS ${renditionArgs(rendition, hlsKeyOption, { crop: variant.crop, stripAudio: plan.stripAudio, atSourceSize, perTitle: plan.perTitle })}"`,
			`  RENDITIONS="$RENDITIONS ${rendition.name}"`,
			`  HLS_TOP="${rendition.name}"`,
			...markRung(rendition, atSourceSize),
		]),
		// The ladder is ONE output, measured by its highest rung (its probe frame has the real size).
		recordRendition("/tmp/probe/$HLS_TOP.jpg", variant.name, "hls", "$HLS_TOP", keys.playlistKey),
	];
}

function mp4Script(variant: PlannedVariant, plan: TranscodePlan, keys: OutputKeys) {
	const bitrates = new Map(variant.mp4.map((output) => [output.rendition.name, output.bitrateKbps]));
	const rungs = variant.mp4.map((output) => output.rendition);
	return rungBlocks(rungs, "MP4_DONE", (rendition, atSourceSize) => {
		const options = {
			crop: variant.crop,
			stripAudio: plan.stripAudio,
			atSourceSize,
			perTitle: plan.perTitle,
			// At source size the requested rung's bitrate is overkill: constant quality with the rung's cap instead.
			bitrateKbps: atSourceSize ? undefined : bitrates.get(rendition.name),
		};
		const key = `${keys.mp4Prefix}${mp4FileName(variant.name, rendition)}`;
		return [
			`  FF_OUTPUTS="$FF_OUTPUTS ${mp4Args(variant.name, rendition, options)}"`,
			`  ${recordRendition(`/tmp/mp4/${mp4FileName(variant.name, rendition)}`, variant.name, "mp4", rendition.name, key)}`,
			...markRung(rendition, atSourceSize),
		];
	});
}

function variantScript(
	variant: PlannedVariant,
	index: number,
	plan: TranscodePlan,
	hlsKeyOption: string,
	keys: OutputKeys,
) {
	return [
		`# frame ${variant.name}`,
		...variantShortSide(variant),
		// Even short side: the one that will have an output at source size.
		"V_EVEN=$((V_SHORT / 2 * 2))",
		"V_TOP=0",
		...hlsScript(variant, plan, hlsKeyOption, keys),
		...mp4Script(variant, plan, keys),
		...(index === 0 ? ["POSTER_SHORT=$V_TOP"] : []),
		`echo "[transcode] ${variant.name}: short $V_SHORT top $V_TOP"`,
	];
}

export function planSetupScript(plan: TranscodePlan, hlsKeyOption: string, keys: OutputKeys = NO_KEYS): string {
	if (plan.variants.length === 0) throw new Error("planSetupScript: plan has no outputs");
	return [
		// `width,height` of the video stream. The short side doesn't change with rotation (phone metadata).
		...shortSideScript("SRC", FRAME_DIMS("/tmp/input")),
		'FF_OUTPUTS=""',
		'RENDITIONS=""',
		'TOP_RES=""',
		"TOP_SHORT=0",
		RECORD_RENDITION_FUNCTION,
		": > /tmp/outputs.list",
		"POSTER_SHORT=0",
		...plan.variants.flatMap((variant, index) => variantScript(variant, index, plan, hlsKeyOption, keys)),
		// Storyboard: one more output from the same ffmpeg (shares the decode); doesn't count as a video output.
		...storyboardOutputScript(plan),
		'echo "[transcode] source $SRC_DIMS (short $SRC_SHORT) top $TOP_RES (short $TOP_SHORT) outputs $(wc -l < /tmp/outputs.list)"',
	].join("\n");
}

/** Legacy HLS ladder (no crop, no MP4). */
export function ladderSetupScript(maxResolution: MaxResolution, hlsKeyOption: string): string {
	return planSetupScript(legacyPlan(maxResolution), hlsKeyOption);
}
