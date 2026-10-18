// Transcode presets: legacy aliases + ready-to-use templates, and the
// name/spec → spec resolution the worker applies. A client that names nothing uploads and the worker's config decides.
import { TranscodePreset } from "./constants";
import { type TranscodeSpec, validateTranscodeSpec } from "./transcode-spec";

/** Legacy aliases: HLS ladder up to the resolution cap. Still valid in `preset`. */
export const LEGACY_PRESET_SPECS: Record<TranscodePreset, TranscodeSpec> = {
	[TranscodePreset.HLS_720P]: { hls: {} },
	[TranscodePreset.HLS_ADAPTIVE]: { hls: {} },
};

export const TranscodeTemplate = {
	WEB_ADAPTIVE: "web-adaptive",
	HERO: "hero",
	SOCIAL_VERTICAL: "social-vertical",
} as const;

export type TranscodeTemplate = (typeof TranscodeTemplate)[keyof typeof TranscodeTemplate];

/** Templates for building custom presets (and that `preset` accepts by name). */
export const TRANSCODE_TEMPLATES: Record<TranscodeTemplate, TranscodeSpec> = {
	// Web player: HLS 720/1080 with poster.
	[TranscodeTemplate.WEB_ADAPTIVE]: {
		hls: { rungs: ["720p", "1080p"] },
		poster: { at: "auto", formats: ["jpg", "avif"] },
	},
	// Hero background video: horizontal MP4 1080p at target bitrate + 720p, vertical 9:16 MP4 for mobile,
	// poster from the first frame (what's shown before the loop starts) and no audio (autoplay muted). No
	// storyboard: a background loop has no progress bar.
	[TranscodeTemplate.HERO]: {
		mp4: { rungs: ["720p", "1080p"], bitrate: { "720p": 2500, "1080p": 5000 } },
		audio: "strip",
		poster: { at: "first", formats: ["jpg", "avif"] },
		variants: [{ name: "vertical", crop: "9:16-center", mp4: { rungs: ["1080p"], bitrate: { "1080p": 4000 } } }],
		storyboard: false,
	},
	// Reels/stories: everything cropped to 9:16, HLS for the player and an MP4 for sharing.
	[TranscodeTemplate.SOCIAL_VERTICAL]: {
		crop: "9:16-center",
		hls: { rungs: ["720p", "1080p"] },
		mp4: { rungs: ["1080p"] },
		poster: { at: "auto", formats: ["jpg", "avif"] },
	},
};

/** Named presets from the Worker's config (`config.transcode.presets`) and the default. */
export interface TranscodeSettings {
	presets?: Record<string, TranscodeSpec>;
	default?: string;
}

/** Where the spec came from: inline in the request, the config, a template, or a legacy alias. */
export type PresetSource = "inline" | "config" | "template" | "legacy";

export type PresetResolution =
	| { ok: true; spec: TranscodeSpec; name: string; source: PresetSource }
	| { ok: false; errors: string[] };

function resolveByName(name: string, settings: TranscodeSettings | undefined): PresetResolution {
	const configSpec = settings?.presets?.[name];
	if (configSpec) return { ok: true, spec: configSpec, name, source: "config" };
	const templateSpec = TRANSCODE_TEMPLATES[name as TranscodeTemplate];
	if (templateSpec) return { ok: true, spec: templateSpec, name, source: "template" };
	const legacySpec = LEGACY_PRESET_SPECS[name as TranscodePreset];
	if (legacySpec) return { ok: true, spec: legacySpec, name, source: "legacy" };
	return { ok: false, errors: [`preset: unknown preset "${name}"`] };
}

/**
 * Spec to apply: the request's `preset` (name or inline spec) → the config's default → `hls-720p`.
 * Names: config presets, then templates, then aliases. A stored spec is re-validated (defense: the
 * worker never trusts what it reads from the config).
 */
export function resolveTranscodePreset(requested: unknown, settings: TranscodeSettings | undefined): PresetResolution {
	if (requested !== undefined && requested !== null && typeof requested !== "string") {
		const validation = validateTranscodeSpec(requested);
		if (!validation.ok) return validation;
		return { ok: true, spec: validation.spec, name: "inline", source: "inline" };
	}
	const name = requested || settings?.default || TranscodePreset.HLS_720P;
	const resolved = resolveByName(name, settings);
	if (!resolved.ok || resolved.source !== "config") return resolved;
	const validation = validateTranscodeSpec(resolved.spec);
	if (!validation.ok) return validation;
	return { ...resolved, spec: validation.spec };
}
