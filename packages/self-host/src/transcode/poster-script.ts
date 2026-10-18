// Poster + thumbnail of the transcode. The poster comes from the first frame (same crop) at the resolution of its
// highest rung; the thumbnail (640 px, same as always) is derived from the poster. Both outside /tmp/output (not HLS).
import type { PosterAt } from "@devultur/core";
import { cropFilter } from "../transcode-ladder";
import type { TranscodePlan } from "./plan";

// `auto` = min(5 s, 10% of duration): a 3 s clip no longer falls outside the video (black/empty poster).
const AUTO_OFFSET_AWK = "t = d * 0.1; if (t > 5) t = 5";

/** Shell that leaves `POSTER_SEEK` = ffmpeg seek args (empty for `first`). Requires `$DURATION`. */
export function posterSeekScript(at: PosterAt): string {
	if (at === "first") return 'POSTER_SEEK=""';
	const offset =
		at === "auto"
			? `BEGIN { ${AUTO_OFFSET_AWK}; printf "%.3f", t }`
			: // A fixed second past the end falls back to `auto` (otherwise ffmpeg wouldn't produce any frame).
				`BEGIN { if (${at} < d) t = ${at}; else { ${AUTO_OFFSET_AWK} } printf "%.3f", t }`;
	return [`POSTER_AT=$(awk -v d="$DURATION" '${offset}')`, 'POSTER_SEEK="-ss $POSTER_AT"'].join("\n");
}

function posterFilter(plan: TranscodePlan): string {
	const scale = "scale=$POSTER_SHORT:$POSTER_SHORT:force_original_aspect_ratio=increase:force_divisible_by=2";
	const crop = plan.variants[0]?.crop;
	return crop ? `${cropFilter(crop)},${scale}` : scale;
}

export function posterScript(plan: TranscodePlan): string {
	const grabPoster = (seek: string) =>
		`ffmpeg -nostdin -v error -y ${seek}-i /tmp/input -frames:v 1 -vf "${posterFilter(plan)}" -q:v 2 -update 1 /tmp/poster.jpg`;
	return [
		posterSeekScript(plan.posterAt),
		'if [ "$POSTER_SHORT" -le 0 ] 2>/dev/null; then POSTER_SHORT=720; fi',
		// `-ss` before `-i`: keyframe seek + decode up to the instant (precise and fast).
		`${grabPoster("$POSTER_SEEK ")} || true`,
		// No frame at that instant (misreported duration) → the first frame, never an empty poster.
		`[ -s /tmp/poster.jpg ] || ${grabPoster("")}`,
		'ffmpeg -nostdin -v error -y -i /tmp/poster.jpg -vf "scale=640:-2" -q:v 2 -update 1 /tmp/thumbnail.jpg',
	].join("\n");
}

/** Shell that leaves `HAS_AUDIO` (`true`/`false`, JSON) — always false if the plan strips audio. */
export function hasAudioScript(plan: TranscodePlan): string {
	if (plan.stripAudio) return "HAS_AUDIO=false";
	return [
		"AUDIO_STREAM=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 /tmp/input | head -1)",
		'if [ -n "$AUDIO_STREAM" ]; then HAS_AUDIO=true; else HAS_AUDIO=false; fi',
	].join("\n");
}
