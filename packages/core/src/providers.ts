export const StorageProvider = {
	R2: "r2",
} as const;

export type StorageProvider = (typeof StorageProvider)[keyof typeof StorageProvider];

export const TranscodeProvider = {
	FLY_IO: "fly.io",
} as const;

export type TranscodeProvider = (typeof TranscodeProvider)[keyof typeof TranscodeProvider];

export const SpeechProvider = {
	GROQ_WHISPER: "groq-whisper",
} as const;

export type SpeechProvider = (typeof SpeechProvider)[keyof typeof SpeechProvider];

export const TranslationProvider = {
	MISTRAL: "mistral",
} as const;

export type TranslationProvider = (typeof TranslationProvider)[keyof typeof TranslationProvider];

export const ImageFit = {
	COVER: "cover",
	CONTAIN: "contain",
	FILL: "fill",
	INSIDE: "inside",
} as const;

export type ImageFit = (typeof ImageFit)[keyof typeof ImageFit];

export const ImageFormat = {
	WEBP: "webp",
	AVIF: "avif",
	JPEG: "jpeg",
	PNG: "png",
	AUTO: "auto",
} as const;

export type ImageFormat = (typeof ImageFormat)[keyof typeof ImageFormat];

export const SecurityLevel = {
	SIGNED_URLS: 1,
	TOKEN_BINDING: 2,
	IP_FINGERPRINT: 3,
	AES_128_HLS: 4,
} as const;

export type SecurityLevel = (typeof SecurityLevel)[keyof typeof SecurityLevel];
