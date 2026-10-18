import { getDownloadUrl } from "./download";
import { videoMp4Path, videoPosterPath, videoStoryboardPath } from "./paths";

export interface MediaUrlOptions {
	/** Viewer token for authorized media. Added as `?token=`. */
	token?: string;
	/** Forces a download instead of rendering inline. `true` keeps the original name; a string sets it. */
	download?: boolean | string;
	/** Resize width (px). */
	width?: number;
	/** Resize height (px). */
	height?: number;
	/** Resize fit mode. */
	fit?: "cover" | "contain" | "fill" | "scale-down" | "pad";
	/** Output format. `auto` negotiates via the Accept header. */
	format?: "webp" | "avif" | "jpeg" | "png" | "auto";
	/** Output quality (1–100). */
	quality?: number;
}

/**
 * Builds a media's delivery URL, composing the ENTIRE query correctly:
 * auth (`token`), image transforms (`width`/`height`/`fit`/`format`/`quality`), and
 * download disposition (`download`/filename). It's the single source of truth for media
 * URLs — the consumer never assembles query strings by hand.
 */
export function buildMediaUrl(baseUrl: string, key: string, options?: MediaUrlOptions): string {
	const base = `${baseUrl}/v1/media/${key}`;
	if (!options) return base;

	const params = new URLSearchParams();
	if (options.token) params.set("token", options.token);
	if (options.width) params.set("w", String(options.width));
	if (options.height) params.set("h", String(options.height));
	if (options.fit) params.set("fit", options.fit);
	if (options.format) params.set("format", options.format);
	if (options.quality) params.set("q", String(options.quality));

	const query = params.toString();
	const url = query ? `${base}?${query}` : base;

	// `download` ALWAYS goes last (semantics: "deliver this as a download").
	if (!options.download) return url;
	return getDownloadUrl(url, typeof options.download === "string" ? { filename: options.download } : undefined);
}

/** The minimum to locate a video's outputs: id + visibility (a video `DevulturMedia` works). */
export interface VideoOutputRef {
	id: string;
	visibility: "public" | "private";
}

/**
 * Stable URL for a transcode's MP4 (`{visibility}/video/{id}/mp4/{variant}-{rung}.mp4`). The root
 * crop is `main`. For private media, pass the viewer token in `options`; the tokenless URL never changes.
 */
export function buildVideoMp4Url(
	baseUrl: string,
	video: VideoOutputRef,
	output: { variant?: string; rung: string },
	options?: MediaUrlOptions,
): string {
	const key = `${video.visibility}/${videoMp4Path(video.id, output.variant ?? "main", output.rung)}`;
	return buildMediaUrl(baseUrl, key, options);
}

export interface PosterUrls {
	jpg: string;
	avif: string;
}

/**
 * Stable poster URLs: the JPG the transcode generates and its AVIF served by the image transform
 * (`?format=avif`), with no second file to maintain.
 */
export function buildPosterUrls(baseUrl: string, video: VideoOutputRef, options?: MediaUrlOptions): PosterUrls {
	const key = `${video.visibility}/${videoPosterPath(video.id)}`;
	return {
		jpg: buildMediaUrl(baseUrl, key, options),
		avif: buildMediaUrl(baseUrl, key, { ...options, format: "avif" }),
	};
}

/**
 * Stable storyboard URL (WebVTT with `sprite-N.jpg#xywh=x,y,w,h` per time range). For private media, pass the
 * viewer token in `options`: the worker rewrites the VTT so every sprite carries the same token.
 */
export function buildStoryboardUrl(baseUrl: string, video: VideoOutputRef, options?: MediaUrlOptions): string {
	return buildMediaUrl(baseUrl, `${video.visibility}/${videoStoryboardPath(video.id)}`, options);
}
