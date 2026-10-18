// Declarative spec of a transcode: WHAT outputs are wanted (HLS ladder, standalone MP4s, crop, audio, poster),
// never HOW (never the user's raw ffmpeg args). The worker translates it into commands with whitelisted values and the
// resolution cap still trims the rungs. Pure and dependency-free → shared by the worker and SDKs.

export const TRANSCODE_RUNGS = ["360p", "720p", "1080p", "4k"] as const;
export type TranscodeRung = (typeof TRANSCODE_RUNGS)[number];

export const TRANSCODE_CROPS = ["9:16-center", "1:1-center"] as const;
export type TranscodeCrop = (typeof TRANSCODE_CROPS)[number];

export const POSTER_FORMATS = ["jpg", "avif"] as const;
export type PosterFormat = (typeof POSTER_FORMATS)[number];

/** `first` = first decodable frame; `auto` = min(5s, 10% of duration); number = exact second. */
export type PosterAt = number | "first" | "auto";

export interface Mp4Output {
	rungs: TranscodeRung[];
	/** Target bitrate (kbps) per rung. No entry → constant quality (CRF) with a cap, like HLS. */
	bitrate?: Partial<Record<TranscodeRung, number>>;
}

/** Outputs of a framing. The root spec is the `main` framing; `variants` adds others (e.g. vertical). */
export interface TranscodeOutputs {
	/** Adaptive HLS ladder. `rungs` absent → the whole ladder up to the resolution cap. */
	hls?: { rungs?: TranscodeRung[] };
	mp4?: Mp4Output;
	crop?: TranscodeCrop;
}

/** Extra framing (MP4 only: HLS lives in the main framing, with a single playlist URL). */
export interface TranscodeVariant {
	name: string;
	crop?: TranscodeCrop;
	mp4: Mp4Output;
}

export interface TranscodeSpec extends TranscodeOutputs {
	audio?: "keep" | "strip";
	poster?: { at?: PosterAt; formats?: PosterFormat[] };
	variants?: TranscodeVariant[];
	/**
	 * Per-title encode (default `true`): a short probe measures video complexity and lowers the bitrate cap
	 * (and bumps CRF slightly) for simple content. Never exceeds the ladder's caps; an MP4 with `bitrate` ignores it.
	 */
	perTitle?: boolean;
	/** Storyboard for scrub-bar previews (sprites + WebVTT). Default `true`. */
	storyboard?: boolean;
}

/** Name of the root framing (the one for `hls/` and `mp4/main-*.mp4`). Reserved for `variants`. */
export const MAIN_VARIANT = "main";

export const MAX_VARIANTS = 4;
export const MIN_BITRATE_KBPS = 200;
export const MAX_BITRATE_KBPS = 40_000;
export const MAX_POSTER_SECONDS = 3600;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export type SpecValidation = { ok: true; spec: TranscodeSpec } | { ok: false; errors: string[] };

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const isRung = (value: unknown): value is TranscodeRung => TRANSCODE_RUNGS.includes(value as TranscodeRung);
const isCrop = (value: unknown): value is TranscodeCrop => TRANSCODE_CROPS.includes(value as TranscodeCrop);

/** Valid name for a preset or a variant: short lowercase slug. */
export function isValidOutputName(name: unknown): name is string {
	return typeof name === "string" && NAME_PATTERN.test(name);
}

function rejectUnknownKeys(raw: Raw, allowed: readonly string[], path: string, errors: string[]): void {
	for (const key of Object.keys(raw)) {
		if (!allowed.includes(key)) errors.push(`${path}.${key}: unknown field`);
	}
}

function readRungs(value: unknown, path: string, errors: string[]): TranscodeRung[] | undefined {
	if (!Array.isArray(value) || value.length === 0) {
		errors.push(`${path}: must be a non-empty array of ${TRANSCODE_RUNGS.join(" | ")}`);
		return undefined;
	}
	if (!value.every(isRung)) {
		errors.push(`${path}: unknown rung (allowed: ${TRANSCODE_RUNGS.join(", ")})`);
		return undefined;
	}
	if (new Set(value).size !== value.length) errors.push(`${path}: duplicated rung`);
	return value;
}

function readBitrate(value: unknown, rungs: TranscodeRung[], path: string, errors: string[]) {
	if (!isObject(value)) {
		errors.push(`${path}: must be an object of rung → kbps`);
		return undefined;
	}
	for (const [rung, kbps] of Object.entries(value)) {
		if (!isRung(rung) || !rungs.includes(rung)) errors.push(`${path}.${rung}: not one of this output's rungs`);
		const isInRange =
			Number.isInteger(kbps) && (kbps as number) >= MIN_BITRATE_KBPS && (kbps as number) <= MAX_BITRATE_KBPS;
		if (!isInRange) errors.push(`${path}.${rung}: kbps must be an integer ${MIN_BITRATE_KBPS}–${MAX_BITRATE_KBPS}`);
	}
	return value as Mp4Output["bitrate"];
}

function readMp4(value: unknown, path: string, errors: string[]): Mp4Output | undefined {
	if (!isObject(value)) {
		errors.push(`${path}: must be an object`);
		return undefined;
	}
	rejectUnknownKeys(value, ["rungs", "bitrate"], path, errors);
	const rungs = readRungs(value.rungs, `${path}.rungs`, errors);
	if (!rungs) return undefined;
	if (value.bitrate === undefined) return { rungs };
	return { rungs, bitrate: readBitrate(value.bitrate, rungs, `${path}.bitrate`, errors) };
}

function readHls(value: unknown, path: string, errors: string[]): TranscodeOutputs["hls"] {
	if (!isObject(value)) {
		errors.push(`${path}: must be an object`);
		return undefined;
	}
	rejectUnknownKeys(value, ["rungs"], path, errors);
	if (value.rungs === undefined) return {};
	return { rungs: readRungs(value.rungs, `${path}.rungs`, errors) };
}

function readCrop(value: unknown, path: string, errors: string[]): TranscodeCrop | undefined {
	if (value === undefined) return undefined;
	if (!isCrop(value)) errors.push(`${path}: must be ${TRANSCODE_CROPS.join(" | ")}`);
	return value as TranscodeCrop;
}

function readPosterAt(value: unknown, path: string, errors: string[]): PosterAt | undefined {
	if (value === undefined || value === "first" || value === "auto") return value;
	const isSeconds = typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_POSTER_SECONDS;
	if (!isSeconds) errors.push(`${path}: must be "first", "auto" or seconds 0–${MAX_POSTER_SECONDS}`);
	return value as number;
}

function readPoster(value: unknown, path: string, errors: string[]): TranscodeSpec["poster"] {
	if (!isObject(value)) {
		errors.push(`${path}: must be an object`);
		return undefined;
	}
	rejectUnknownKeys(value, ["at", "formats"], path, errors);
	const at = readPosterAt(value.at, `${path}.at`, errors);
	if (value.formats === undefined) return { at };
	const isFormatList =
		Array.isArray(value.formats) &&
		value.formats.length > 0 &&
		value.formats.every((format) => POSTER_FORMATS.includes(format as PosterFormat));
	if (!isFormatList) errors.push(`${path}.formats: must be a non-empty array of ${POSTER_FORMATS.join(" | ")}`);
	return { at, formats: value.formats as PosterFormat[] };
}

function readVariant(value: unknown, path: string, errors: string[]): TranscodeVariant | undefined {
	if (!isObject(value)) {
		errors.push(`${path}: must be an object`);
		return undefined;
	}
	rejectUnknownKeys(value, ["name", "crop", "mp4"], path, errors);
	if (!isValidOutputName(value.name) || value.name === MAIN_VARIANT) {
		errors.push(`${path}.name: must be a lowercase slug (a-z, 0-9, -; max 32) other than "${MAIN_VARIANT}"`);
	}
	const mp4 = readMp4(value.mp4, `${path}.mp4`, errors);
	const crop = readCrop(value.crop, `${path}.crop`, errors);
	if (!mp4) return undefined;
	return { name: value.name as string, ...(crop ? { crop } : {}), mp4 };
}

function readVariants(value: unknown, errors: string[]): TranscodeVariant[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_VARIANTS) {
		errors.push(`variants: must be an array of at most ${MAX_VARIANTS}`);
		return undefined;
	}
	const variants = value.map((variant, index) => readVariant(variant, `variants[${index}]`, errors));
	const names = value.map((variant) => (isObject(variant) ? variant.name : undefined));
	if (new Set(names).size !== names.length) errors.push("variants: names must be unique");
	return variants.filter((variant): variant is TranscodeVariant => variant !== undefined);
}

const SPEC_FIELDS = ["hls", "mp4", "crop", "audio", "poster", "variants", "perTitle", "storyboard"] as const;
const SWITCH_FIELDS = ["perTitle", "storyboard"] as const;

function readSwitches(input: Raw, spec: TranscodeSpec, errors: string[]): void {
	for (const field of SWITCH_FIELDS) {
		const value = input[field];
		if (value === undefined) continue;
		if (typeof value !== "boolean") {
			errors.push(`${field}: must be true | false`);
			continue;
		}
		spec[field] = value;
	}
}

/**
 * Strictly validates a spec arriving from the outside (request, config). Rejects unknown fields and values
 * outside the whitelist; never lets free-form strings through to the command. Returns the normalized spec.
 */
export function validateTranscodeSpec(input: unknown): SpecValidation {
	if (!isObject(input)) return { ok: false, errors: ["spec: must be an object"] };
	const errors: string[] = [];
	rejectUnknownKeys(input, SPEC_FIELDS, "spec", errors);

	const spec: TranscodeSpec = {};
	if (input.hls !== undefined) spec.hls = readHls(input.hls, "hls", errors);
	if (input.mp4 !== undefined) spec.mp4 = readMp4(input.mp4, "mp4", errors);
	const crop = readCrop(input.crop, "crop", errors);
	if (crop) spec.crop = crop;
	if (input.audio !== undefined && input.audio !== "keep" && input.audio !== "strip") {
		errors.push('audio: must be "keep" | "strip"');
	}
	if (input.audio !== undefined) spec.audio = input.audio as TranscodeSpec["audio"];
	if (input.poster !== undefined) spec.poster = readPoster(input.poster, "poster", errors);
	if (input.variants !== undefined) spec.variants = readVariants(input.variants, errors);
	readSwitches(input, spec, errors);

	const hasMainOutput = input.hls !== undefined || input.mp4 !== undefined;
	const hasVariantOutput = Array.isArray(input.variants) && input.variants.length > 0;
	if (!hasMainOutput && !hasVariantOutput) errors.push("spec: needs at least one output (hls, mp4 or variants)");

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, spec };
}
