// Outputs reported by `transcode.complete` (keys). The record and internal events store only keys; the
// client's webhook carries URLs built from the host that was pinned when the job was accepted
// (`outputBaseUrl`), never the host the request came in on.
import {
	buildTranscodeOutputUrls,
	type PosterFormat,
	type StoredRendition,
	type TranscodeOutputKeys,
	type TranscodeOutputUrls,
} from "@devultur/core";
import { KV_JOB_TTL_SECONDS, KvPrefix } from "../helpers";

type Raw = Record<string, unknown>;

// Only keys for assets derived from a video: no URLs or arbitrary paths the event might carry.
const isOutputKey = (value: unknown): value is string =>
	typeof value === "string" && /^(public|private)\/video\/[^/]+\/(hls|mp4|thumbnails)\/[^/]+$/.test(value);
const isPosterFormat = (value: unknown): value is PosterFormat => value === "jpg" || value === "avif";

const isPixelSize = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function readRendition(raw: unknown): StoredRendition | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { variant, kind, rung, key, width, height } = raw as Raw;
	if (typeof variant !== "string" || typeof rung !== "string" || !isOutputKey(key)) return null;
	if (kind !== "hls" && kind !== "mp4") return null;
	// The real size of the output (the HLS ladder's, by its top rung). Absent if the runner couldn't measure it.
	const size = isPixelSize(width) && isPixelSize(height) ? { width, height } : {};
	return { variant, kind, rung, key, ...size };
}

const STORYBOARD_KEY = /^(public|private)\/video\/[^/]+\/storyboard\/storyboard\.vtt$/;

/** Storyboard key from a `transcode.complete` (any plan), or null if there was no storyboard. */
export function readStoryboardKey(event: unknown): string | null {
	if (typeof event !== "object" || event === null) return null;
	const { storyboardKey } = event as Raw;
	return typeof storyboardKey === "string" && STORYBOARD_KEY.test(storyboardKey) ? storyboardKey : null;
}

/**
 * `storyboardKey` toward the client with the same criterion as `renditions`: only if the event reports
 * outputs (config presets, templates, inline specs). With the `hls-*` aliases the event stays as before: a
 * strictly validating handler would see a new field and break its webhook. Empty/invalid → dropped.
 */
export function withClientStoryboard(event: Raw): Raw {
	if (!("storyboardKey" in event)) return event;
	const { storyboardKey: _dropped, ...rest } = event;
	const storyboardKey = readStoryboardKey(event);
	if (!storyboardKey || !Array.isArray(event.renditions)) return rest;
	return { ...rest, storyboardKey };
}

/** Outputs (keys) from a `transcode.complete`, or null if the event doesn't report them (`hls-*` alias, old script). */
export function readTranscodeOutputKeys(event: unknown): TranscodeOutputKeys | null {
	if (typeof event !== "object" || event === null) return null;
	const raw = event as Raw;
	if (raw.event !== "transcode.complete" || !Array.isArray(raw.renditions)) return null;
	const renditions = raw.renditions.map(readRendition).filter((rendition) => rendition !== null);
	const posterFormats = Array.isArray(raw.posterFormats) ? raw.posterFormats.filter(isPosterFormat) : undefined;
	return {
		renditions,
		...(isOutputKey(raw.posterKey) ? { posterKey: raw.posterKey } : {}),
		...(posterFormats?.length ? { posterFormats } : {}),
		...(typeof raw.hasAudio === "boolean" ? { hasAudio: raw.hasAudio } : {}),
	};
}

/** Outputs in their public form (URLs built from `baseUrl`), or null if the event doesn't report them. */
export function readTranscodeOutputs(event: unknown, baseUrl: string): TranscodeOutputUrls | null {
	const keys = readTranscodeOutputKeys(event);
	return keys ? buildTranscodeOutputUrls(baseUrl, keys) : null;
}

/** Event with the outputs in their public form (renditions with `url`, `posterUrls`). No outputs → unchanged. */
export function withOutputUrls(event: Raw, baseUrl: string): Raw {
	const outputs = readTranscodeOutputs(event, baseUrl);
	if (!outputs) return event;
	return { ...event, ...outputs };
}

// Base of the webhook URLs per video, pinned when the job is accepted (with the config in context). The
// runner's callback arrives without it, which is why it's saved.
const outputBaseKey = (videoId: string) => `${KvPrefix.TRANSCODE_META}:output-base:${videoId}`;

export function saveOutputBaseUrl(kv: KVNamespace, videoId: string, baseUrl: string): Promise<void> {
	return kv.put(outputBaseKey(videoId), baseUrl, { expirationTtl: KV_JOB_TTL_SECONDS });
}

/** Saved base for the video, or `fallbackUrl` (the request's origin) if there isn't one (job from before this field existed). */
export async function loadOutputBaseUrl(kv: KVNamespace, videoId: unknown, fallbackUrl: string): Promise<string> {
	if (typeof videoId !== "string" || !videoId) return fallbackUrl;
	return (await kv.get(outputBaseKey(videoId))) ?? fallbackUrl;
}
