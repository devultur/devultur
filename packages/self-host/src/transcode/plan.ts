// Validated spec + resolution cap → concrete plan of outputs (which rungs, with what crop and bitrate). The cut by
// the SOURCE's resolution (no upscaling) happens later, at runtime, inside the script (plan-script.ts).
import { MAIN_VARIANT, type PosterAt, type PosterFormat, type TranscodeCrop, type TranscodeSpec } from "@devultur/core";
import { clampRungsToCap, type Rendition, renditionsFor } from "../transcode-ladder";
import type { MaxResolution } from "../types";

export interface PlannedMp4 {
	rendition: Rendition;
	bitrateKbps?: number;
}

export interface PlannedVariant {
	name: string;
	crop?: TranscodeCrop;
	/** HLS ladder (main frame only). Empty → no HLS. */
	hls: readonly Rendition[];
	mp4: PlannedMp4[];
}

export interface TranscodePlan {
	variants: PlannedVariant[];
	stripAudio: boolean;
	posterAt: PosterAt;
	posterFormats: PosterFormat[];
	/**
	 * Report the outputs (`renditions`, `posterUrls`, `hasAudio`) in `transcode.complete`. Only with config
	 * presets or inline specs: the `hls-*` aliases keep the usual event so strict handlers don't break.
	 */
	reportsOutputs: boolean;
	/** Complexity probe + per-title CRF/maxrate (per-title.ts). Spec default: on. */
	perTitle: boolean;
	/** Sprites + WebVTT for the scrub bar's previews (storyboard-script.ts). Spec default: on. */
	storyboard: boolean;
}

const DEFAULT_POSTER_FORMATS: PosterFormat[] = ["jpg", "avif"];

function planMp4(output: TranscodeSpec["mp4"], maxResolution: MaxResolution): PlannedMp4[] {
	if (!output) return [];
	return clampRungsToCap(output.rungs, maxResolution).map((rendition) => {
		const bitrateKbps = output.bitrate?.[rendition.name];
		return bitrateKbps ? { rendition, bitrateKbps } : { rendition };
	});
}

function planHls(output: TranscodeSpec["hls"], maxResolution: MaxResolution): readonly Rendition[] {
	if (!output) return [];
	if (!output.rungs) return renditionsFor(maxResolution);
	return clampRungsToCap(output.rungs, maxResolution);
}

function planMainVariant(spec: TranscodeSpec, maxResolution: MaxResolution): PlannedVariant | null {
	if (!spec.hls && !spec.mp4) return null;
	return {
		name: MAIN_VARIANT,
		...(spec.crop ? { crop: spec.crop } : {}),
		hls: planHls(spec.hls, maxResolution),
		mp4: planMp4(spec.mp4, maxResolution),
	};
}

export function planTranscode(
	spec: TranscodeSpec,
	maxResolution: MaxResolution,
	options: { reportsOutputs: boolean },
): TranscodePlan {
	const main = planMainVariant(spec, maxResolution);
	const extraVariants = (spec.variants ?? []).map<PlannedVariant>((variant) => ({
		name: variant.name,
		...(variant.crop ? { crop: variant.crop } : {}),
		hls: [],
		mp4: planMp4(variant.mp4, maxResolution),
	}));
	return {
		variants: main ? [main, ...extraVariants] : extraVariants,
		stripAudio: spec.audio === "strip",
		posterAt: spec.poster?.at ?? "auto",
		posterFormats: spec.poster?.formats ?? DEFAULT_POSTER_FORMATS,
		reportsOutputs: options.reportsOutputs,
		perTitle: spec.perTitle ?? true,
		storyboard: spec.storyboard ?? true,
	};
}

/** Legacy transcode plan: HLS ladder up to the cap, poster `auto`, event with no outputs. */
export function legacyPlan(maxResolution: MaxResolution): TranscodePlan {
	return planTranscode({ hls: {} }, maxResolution, { reportsOutputs: false });
}
