// Per-title encoding (content-aware). Before encoding, a SHORT PROBE measures how many bits the content asks for:
// a few 2 s segments sampled across the video are encoded at 360p with a fixed CRF and a fast preset, and
// the resulting bitrate (kbps) is the complexity. It's the most direct signal for what we want to estimate (the
// bit cost of x264 at constant quality); `signalstats`/`scdet` measure proxies (brightness, cuts) that don't map to bits.
// Cost: ≤ 4 samples of 2 s at 360p `veryfast` with keyframe seeking → a fraction of the real encode (see the smoke test).
//
// Complexity → parameters per rung, always within the ladder's caps:
//   - maxrate: from 50% of the cap (simple content: slides, talking heads) to 100% (complex). Never above the cap.
//   - CRF: +2 on the simplest content, +1 in between, +0 on the most complex. Never below the base CRF.
// An MP4 with an explicit `bitrate` in the spec skips this (the spec wins). Without a probe (short clip, failed
// probe, or `perTitle: false`) the ladder's base parameters are used, identical to before.
import { RENDITION_LADDER, type Rendition } from "../transcode-ladder";
import type { TranscodePlan } from "./plan";

export const PER_TITLE = {
	/** Shorter clips aren't probed: the savings are minimal and the probe would cost more than the encode. */
	minDurationSeconds: 10,
	sampleSeconds: 2,
	maxSamples: 4,
	/** One sample every this many seconds of video (up to `maxSamples`). */
	secondsPerSample: 15,
	probeShortSide: 360,
	probeCrf: 23,
	probePreset: "veryfast",
	/** Probe kbps (360p, CRF 23) at the simple end (score 0) and the complex end (score 1); logarithmic scale. */
	simpleKbps: 100,
	complexKbps: 800,
	minMaxrateFactor: 0.5,
	maxCrfBoost: 2,
} as const;

export interface RateParams {
	crf: number;
	maxrateKbps: number;
}

/** Probe sample count for a duration (0 = no probe). */
export function probeSampleCount(durationSeconds: number): number {
	if (!(durationSeconds >= PER_TITLE.minDurationSeconds)) return 0;
	const bySpacing = Math.floor(durationSeconds / PER_TITLE.secondsPerSample);
	return Math.min(PER_TITLE.maxSamples, Math.max(1, bySpacing));
}

/** Score 0 (simple) – 1 (complex), with 2 decimals, from the probe's kbps. */
export function complexityScore(probeKbps: number): number {
	const span = Math.log(PER_TITLE.complexKbps / PER_TITLE.simpleKbps);
	const raw = Math.log(Math.max(probeKbps, 1) / PER_TITLE.simpleKbps) / span;
	const clamped = Math.min(1, Math.max(0, raw));
	return Math.round(clamped * 100) / 100;
}

/** CRF + maxrate of a rung for a score; `null` (no probe) = the ladder's values. */
export function perTitleRate(rendition: Rendition, score: number | null): RateParams {
	if (score === null) return { crf: rendition.crf, maxrateKbps: rendition.maxrateKbps };
	const factor = PER_TITLE.minMaxrateFactor + (1 - PER_TITLE.minMaxrateFactor) * score;
	return {
		crf: rendition.crf + Math.round(PER_TITLE.maxCrfBoost * (1 - score)),
		maxrateKbps: Math.round(rendition.maxrateKbps * factor),
	};
}

/** Shell variable suffix for a rung (`1080p` → `1080P`, `4k` → `4K`). */
export const rateTag = (rendition: Rendition) => rendition.name.toUpperCase();

/** Plan rungs that encode at CRF with a cap (MP4s with a bitrate in the spec are excluded). */
export function crfRungs(plan: TranscodePlan): Rendition[] {
	const names = new Set<string>();
	for (const variant of plan.variants) {
		for (const rendition of variant.hls) names.add(rendition.name);
		for (const output of variant.mp4) {
			if (!output.bitrateKbps) names.add(output.rendition.name);
		}
	}
	return RENDITION_LADDER.filter((rendition) => names.has(rendition.name));
}

const PROBE_FILE = "/tmp/probe/per-title.h264";

function probeEncode(): string {
	const side = PER_TITLE.probeShortSide;
	return [
		`ffmpeg -nostdin -v error -y -ss "$PROBE_AT" -t ${PER_TITLE.sampleSeconds} -i /tmp/input -map 0:v:0 -an`,
		`-vf scale=${side}:${side}:force_original_aspect_ratio=increase:force_divisible_by=2`,
		`-c:v libx264 -preset ${PER_TITLE.probePreset} -crf ${PER_TITLE.probeCrf} -pix_fmt yuv420p -f h264 ${PROBE_FILE}`,
	].join(" ");
}

// Samples + kbps → PT_SCORE (or `null` if there was no probe). A failed sample discards the probe (not the job).
function probeScript(): string[] {
	const { minDurationSeconds, secondsPerSample, maxSamples, sampleSeconds } = PER_TITLE;
	const span = Math.log(PER_TITLE.complexKbps / PER_TITLE.simpleKbps);
	return [
		`PROBE_SAMPLES=$(awk -v d="$DURATION" 'BEGIN { if (!(d >= ${minDurationSeconds})) { print 0; exit } n = int(d / ${secondsPerSample}); if (n < 1) n = 1; if (n > ${maxSamples}) n = ${maxSamples}; print n }')`,
		"PROBE_BYTES=0",
		"PROBE_DONE=0",
		'while [ "$PROBE_DONE" -lt "$PROBE_SAMPLES" ]; do',
		// Center of each equal-length segment, minus half a sample: always within the video.
		`  PROBE_AT=$(awk -v d="$DURATION" -v n="$PROBE_SAMPLES" -v i="$PROBE_DONE" 'BEGIN { t = (i + 0.5) * d / n - ${sampleSeconds / 2}; if (t < 0) t = 0; printf "%.3f", t }')`,
		`  if ! ${probeEncode()}; then PROBE_BYTES=0; break; fi`,
		`  PROBE_BYTES=$((PROBE_BYTES + $(wc -c < ${PROBE_FILE})))`,
		"  PROBE_DONE=$((PROBE_DONE + 1))",
		"done",
		'if [ "$PROBE_BYTES" -gt 0 ]; then',
		`  PROBE_KBPS=$(awk -v b="$PROBE_BYTES" -v n="$PROBE_SAMPLES" 'BEGIN { printf "%.1f", b * 8 / 1000 / (n * ${sampleSeconds}) }')`,
		`  PT_SCORE=$(awk -v k="$PROBE_KBPS" 'BEGIN { if (k < 1) k = 1; s = log(k / ${PER_TITLE.simpleKbps}) / ${span}; if (s < 0) s = 0; if (s > 1) s = 1; printf "%.2f", s }')`,
		"fi",
	];
}

// Per-rung parameters from PT_SCORE (same formula as `perTitleRate`). No score → the base ones.
function rateVarsScript(): string[] {
	const { minMaxrateFactor, maxCrfBoost } = PER_TITLE;
	return [
		"PT_BOOST=0",
		`if [ "$PT_SCORE" != null ]; then PT_BOOST=$(awk -v s="$PT_SCORE" 'BEGIN { printf "%d", int(${maxCrfBoost} * (1 - s) + 0.5) }'); fi`,
		...RENDITION_LADDER.flatMap((rendition) => {
			const tag = rateTag(rendition);
			return [
				`PT_CRF_${tag}=$((${rendition.crf} + PT_BOOST))`,
				`PT_MAXRATE_${tag}=${rendition.maxrateKbps}`,
				`if [ "$PT_SCORE" != null ]; then PT_MAXRATE_${tag}=$(awk -v s="$PT_SCORE" 'BEGIN { printf "%d", int(${rendition.maxrateKbps} * (${minMaxrateFactor} + ${1 - minMaxrateFactor} * s) + 0.5) }'); fi`,
				`PT_BUFSIZE_${tag}=$((PT_MAXRATE_${tag} * 2))`,
			];
		}),
	];
}

/**
 * Shell that leaves `PT_SCORE` (0–1 or `null`), `PROBE_SECONDS` and `PT_CRF_*` / `PT_MAXRATE_*` / `PT_BUFSIZE_*` per
 * rung, which the plan's ffmpeg args read when they're assembled. Requires `$DURATION`; runs BEFORE the plan setup.
 */
export function perTitleScript(plan: TranscodePlan): string {
	return [
		"PT_SCORE=null",
		"PROBE_START=$(date +%s)",
		...(plan.perTitle ? probeScript() : []),
		"PROBE_SECONDS=$(( $(date +%s) - PROBE_START ))",
		...rateVarsScript(),
		'echo "[transcode] per-title score $PT_SCORE (probe $PROBE_SECONDS s)"',
	].join("\n");
}

/** JSON (escaped for curl's `-d "…"`) of the parameters chosen per rung, for `transcode.complete`. */
export function encodeParamsJson(plan: TranscodePlan): string {
	const entries = crfRungs(plan).map((rendition) => {
		const tag = rateTag(rendition);
		return `{\\"rung\\":\\"${rendition.name}\\",\\"crf\\":$PT_CRF_${tag},\\"maxrateKbps\\":$PT_MAXRATE_${tag}}`;
	});
	return `[${entries.join(",")}]`;
}
