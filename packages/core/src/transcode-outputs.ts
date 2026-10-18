// Transcode outputs stored as KEYS (record, internal events) and their public form with URLs. The URL
// depends on the host the media is viewed from, so it's never
// persisted: it's built per request with the appropriate base.
import { buildMediaUrl, type MediaUrlOptions, type PosterUrls } from "./media-url";
import type { PosterFormat } from "./transcode-spec";
import type { TranscodeRendition } from "./types";

/** An output as it's stored: without a URL. */
export type StoredRendition = Omit<TranscodeRendition, "url">;

export interface TranscodeOutputKeys {
	renditions?: StoredRendition[];
	/** Key of the poster JPG; the AVIF is derived from it via transform (`?format=avif`). */
	posterKey?: string;
	posterFormats?: PosterFormat[];
	hasAudio?: boolean;
}

export interface TranscodeOutputUrls {
	renditions: TranscodeRendition[];
	posterUrls?: Partial<PosterUrls>;
	hasAudio?: boolean;
}

function posterUrlsFor(baseUrl: string, outputs: TranscodeOutputKeys, options?: MediaUrlOptions) {
	if (!outputs.posterKey) return undefined;
	const formats = outputs.posterFormats ?? ["jpg"];
	const posterKey = outputs.posterKey;
	return {
		...(formats.includes("jpg") ? { jpg: buildMediaUrl(baseUrl, posterKey, options) } : {}),
		...(formats.includes("avif") ? { avif: buildMediaUrl(baseUrl, posterKey, { ...options, format: "avif" }) } : {}),
	};
}

/**
 * Stable URLs of the outputs from `baseUrl` (the host it's viewed from: `https://media.example.com` or the
 * custom domain). For private media, pass the viewer token in `options`.
 */
export function buildTranscodeOutputUrls(
	baseUrl: string,
	outputs: TranscodeOutputKeys,
	options?: MediaUrlOptions,
): TranscodeOutputUrls {
	const posterUrls = posterUrlsFor(baseUrl, outputs, options);
	return {
		renditions: (outputs.renditions ?? []).map((rendition) => ({
			...rendition,
			url: buildMediaUrl(baseUrl, rendition.key, options),
		})),
		...(posterUrls ? { posterUrls } : {}),
		...(outputs.hasAudio !== undefined ? { hasAudio: outputs.hasAudio } : {}),
	};
}
