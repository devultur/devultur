// Storyboard for scrub-bar previews: JPG sprite sheets (thumbnail grid) + a WebVTT that
// maps each time range to its crop (`sprite-N.jpg#xywh=x,y,w,h`), the format the players read (Video.js,
// Plyr, JW, Vidstack, @devultur/react's VideoPlayer). Comes out of the SAME encode ffmpeg (one more output
// sharing the decode) and lands in /tmp/storyboard → `{vis}/video/{id}/storyboard/`.
//
// Adaptive interval: every `minIntervalSeconds` on short clips; grows on long ones to stay under
// `maxThumbnails` (≤ 3 sheets of 10×10), so the storyboard's weight stays bounded regardless of duration.
import { cropFilter } from "../transcode-ladder";
import type { TranscodePlan } from "./plan";

export const STORYBOARD = {
	thumbWidth: 160,
	columns: 10,
	rows: 10,
	minIntervalSeconds: 2,
	maxThumbnails: 300,
	jpegQuality: 5,
	vttFile: "storyboard.vtt",
} as const;

const PER_SHEET = STORYBOARD.columns * STORYBOARD.rows;
const DIR = "/tmp/storyboard";

/** Seconds between thumbnails for a given duration (integer, ≥ the minimum). Mirrors `SB_INTERVAL` in the shell. */
export function storyboardInterval(durationSeconds: number): number {
	const byCount = Math.ceil((Number.isFinite(durationSeconds) ? durationSeconds : 0) / STORYBOARD.maxThumbnails);
	return Math.max(STORYBOARD.minIntervalSeconds, byCount);
}

function storyboardFilter(plan: TranscodePlan): string {
	const sample = `fps=1/$SB_INTERVAL,scale=${STORYBOARD.thumbWidth}:-2,tile=${STORYBOARD.columns}x${STORYBOARD.rows}`;
	const crop = plan.variants[0]?.crop;
	return crop ? `${cropFilter(crop)},${sample}` : sample;
}

/** Shell that sets `SB_INTERVAL` and adds the sprites output to `FF_OUTPUTS`. Empty if the plan doesn't ask for it. */
export function storyboardOutputScript(plan: TranscodePlan): string[] {
	if (!plan.storyboard) return [];
	const { maxThumbnails, minIntervalSeconds } = STORYBOARD;
	const args = `-map 0:v:0 -vf ${storyboardFilter(plan)} -q:v ${STORYBOARD.jpegQuality} -start_number 0 ${DIR}/sprite-%d.jpg`;
	return [
		`SB_INTERVAL=$(awk -v d="$DURATION" 'BEGIN { d += 0; i = int(d / ${maxThumbnails}); if (i * ${maxThumbnails} < d) i++; if (i < ${minIntervalSeconds}) i = ${minIntervalSeconds}; print i }')`,
		`FF_OUTPUTS="$FF_OUTPUTS ${args}"`,
	];
}

// WebVTT `hh:mm:ss.mmm` + one cue per thumbnail (up to however many fit in the generated sheets).
const VTT_AWK = [
	'function ts(t,  h, m) { h = int(t / 3600); m = int((t - h * 3600) / 60); return sprintf("%02d:%02d:%06.3f", h, m, t - h * 3600 - m * 60) }',
	"BEGIN {",
	'  print "WEBVTT"',
	"  n = int(d / i); if (n * i < d) n++; if (n > sheets * per) n = sheets * per",
	"  for (k = 0; k < n; k++) {",
	"    start = k * i; end = (k + 1) * i; if (end > d) end = d",
	"    pos = k % per",
	'    print ""; print ts(start) " --> " ts(end)',
	'    printf "sprite-%d.jpg#xywh=%d,%d,%d,%d\\n", int(k / per), (pos % cols) * w, int(pos / cols) * h, w, h',
	"  }",
	"}",
].join("\n");

/**
 * Post-encode shell: builds `storyboard.vtt` from the generated sheets and sets `STORYBOARD_KEY` (empty if there
 * were no sprites: the storyboard never fails the job). The thumbnail size comes from the sheet (fixed grid → width/cols).
 */
export function storyboardVttScript(plan: TranscodePlan, storyboardKey: string): string {
	if (!plan.storyboard) return 'STORYBOARD_KEY=""';
	return [
		'STORYBOARD_KEY=""',
		`if [ -s ${DIR}/sprite-0.jpg ]; then`,
		`  SB_DIMS=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 ${DIR}/sprite-0.jpg | head -1)`,
		`  SB_TILE_W=$(( $(echo "$SB_DIMS" | cut -d, -f1) / ${STORYBOARD.columns} ))`,
		`  SB_TILE_H=$(( $(echo "$SB_DIMS" | cut -d, -f2) / ${STORYBOARD.rows} ))`,
		`  SB_SHEETS=$(ls ${DIR}/sprite-*.jpg | wc -l)`,
		`  awk -v d="$DURATION" -v i="$SB_INTERVAL" -v w="$SB_TILE_W" -v h="$SB_TILE_H" -v sheets="$SB_SHEETS" -v per=${PER_SHEET} -v cols=${STORYBOARD.columns} '${VTT_AWK}' > ${DIR}/${STORYBOARD.vttFile}`,
		`  STORYBOARD_KEY="${storyboardKey}"`,
		`  echo "[transcode] storyboard: $SB_SHEETS sheet(s), every $SB_INTERVAL s, tile \${SB_TILE_W}x$SB_TILE_H"`,
		"fi",
	].join("\n");
}

/** Shell that uploads the sheets and the VTT to `storyboardPrefix` (only if there's a VTT). `put` = the script's PUT command. */
export function storyboardUploadScript(plan: TranscodePlan, storyboardPrefix: string, put: string): string {
	if (!plan.storyboard) return "";
	return [
		'if [ -n "$STORYBOARD_KEY" ]; then',
		`  for f in ${DIR}/*; do`,
		'    FILENAME=$(basename "$f")',
		'    CT="image/jpeg"',
		'    case "$FILENAME" in *.vtt) CT="text/vtt" ;; esac',
		`    ${put} "$WORKER_URL/v1/upload/${storyboardPrefix}$FILENAME" -H "Content-Type: $CT" --data-binary "@$f"`,
		"  done",
		"fi",
	].join("\n");
}
