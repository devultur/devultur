// Image transform params from the query (`?w/h/fit/format/q`). Pure → shared by the route, the cost
// guards, and any layer that embeds the worker.

/** Content-types a transform applies to (the rest ignores the params and is served as is). */
export const IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);

/**
 * `fill` stretches to w×h without respecting the aspect ratio. Cloudflare Images doesn't have it under that name: its
 * equivalent is `squeeze` (see image/cloudflare.ts). It's accepted because the published SDK types it (`MediaUrlOptions.fit`).
 */
export const ImageFit = {
	COVER: "cover",
	CONTAIN: "contain",
	FILL: "fill",
	SCALE_DOWN: "scale-down",
	PAD: "pad",
} as const;

export type ImageFit = (typeof ImageFit)[keyof typeof ImageFit];

const VALID_FITS = new Set<string>(Object.values(ImageFit));
const VALID_FORMATS = new Set(["webp", "avif", "jpeg", "png", "auto"]);
const MAX_DIMENSION = 4096;
const MIN_QUALITY = 1;
const MAX_QUALITY = 100;

export const TRANSFORM_QUERY_PARAMS = ["w", "width", "h", "height", "fit", "format", "q", "quality"];

export interface ImageTransformParams {
	width?: number;
	height?: number;
	fit?: string;
	format?: string;
	quality?: number;
}

export function parseTransformParams(url: URL): ImageTransformParams | null {
	const width = url.searchParams.get("w") ?? url.searchParams.get("width");
	const height = url.searchParams.get("h") ?? url.searchParams.get("height");
	const fit = url.searchParams.get("fit");
	const format = url.searchParams.get("format");
	const quality = url.searchParams.get("q") ?? url.searchParams.get("quality");

	if (!width && !height && !fit && !format && !quality) return null;

	const params: ImageTransformParams = {};

	if (width) {
		const parsed = Number.parseInt(width, 10);
		if (parsed > 0 && parsed <= MAX_DIMENSION) params.width = parsed;
	}
	if (height) {
		const parsed = Number.parseInt(height, 10);
		if (parsed > 0 && parsed <= MAX_DIMENSION) params.height = parsed;
	}
	if (fit && VALID_FITS.has(fit)) params.fit = fit;
	if (format && VALID_FORMATS.has(format)) params.format = format;
	if (quality) {
		const parsed = Number.parseInt(quality, 10);
		if (parsed >= MIN_QUALITY && parsed <= MAX_QUALITY) params.quality = parsed;
	}

	return Object.keys(params).length > 0 ? params : null;
}

export function hasTransformQuery(url: URL): boolean {
	return TRANSFORM_QUERY_PARAMS.some((param) => url.searchParams.has(param));
}
