import type { CaptionLocale, TranscodePreset } from "./constants";
import type { SpeechProvider, StorageProvider, TranscodeProvider, TranslationProvider } from "./providers";

// Video module config for the Convex component. `transcodePreset` and `captionLocales` are the
// defaults the connector passes when processing a video. Note: the worker may cap the resolution
// with its own ceiling (the preset is a ceiling, not a guarantee). Size/mime/visibility and the caption
// whitelist are server-authoritative (Worker config policy), NOT client config.
export interface VideoModuleConfig {
	/** Omitted → the config's default. A name: config preset, template, or `hls-*` alias. */
	transcodePreset?: TranscodePreset | (string & {});
	captionLocales?: CaptionLocale[];
}

export interface StorageConnectorConfig {
	provider: StorageProvider;
}

export interface TranscodeConnectorConfig {
	provider: TranscodeProvider;
}

export interface SpeechConnectorConfig {
	provider: SpeechProvider;
}

export interface TranslationConnectorConfig {
	provider: TranslationProvider;
}

export interface DevulturConfig {
	video?: VideoModuleConfig;
	storage?: StorageConnectorConfig;
	transcode?: TranscodeConnectorConfig;
	speech?: SpeechConnectorConfig;
	translation?: TranslationConnectorConfig;
}
