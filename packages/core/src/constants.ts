export const TranscodePreset = {
	HLS_720P: "hls-720p",
	HLS_ADAPTIVE: "hls-adaptive",
} as const;

export type TranscodePreset = (typeof TranscodePreset)[keyof typeof TranscodePreset];

export const TranscodeStatus = {
	QUEUED: "queued",
	RUNNING: "running",
	COMPLETED: "completed",
	FAILED: "failed",
} as const;

export type TranscodeStatus = (typeof TranscodeStatus)[keyof typeof TranscodeStatus];

export const CaptionStatus = {
	PROCESSING: "processing",
	COMPLETED: "completed",
	FAILED: "failed",
} as const;

export type CaptionStatus = (typeof CaptionStatus)[keyof typeof CaptionStatus];

export const CaptionLocale = {
	EN: "en",
	ES: "es",
	ES_CO: "es-CO",
	FR: "fr",
	PT: "pt",
	DE: "de",
	IT: "it",
	JA: "ja",
	KO: "ko",
	ZH: "zh",
} as const;

export type CaptionLocale = (typeof CaptionLocale)[keyof typeof CaptionLocale] | (string & {});

export const CaptionLocaleLabel = {
	en: "English",
	es: "Español",
	"es-CO": "Español",
	fr: "Français",
	pt: "Português",
	de: "Deutsch",
	it: "Italiano",
	ja: "日本語",
	ko: "한국어",
	zh: "中文",
} as const;

export type CaptionLocaleLabelValue = (typeof CaptionLocaleLabel)[keyof typeof CaptionLocaleLabel];

export const DEFAULT_PRESIGN_EXPIRY_SECONDS = 3600;
export const DEFAULT_TOKEN_EXPIRY_SECONDS = 7200;

export const MediaType = {
	VIDEO: "video",
	IMAGE: "image",
	FILE: "file",
} as const;

export type MediaType = (typeof MediaType)[keyof typeof MediaType];
