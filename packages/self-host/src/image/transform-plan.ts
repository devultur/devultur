// Pure planning for an image transform: output format, geometry, memory guard, and variant keys.
// Nothing here touches R2 or WASM → testable in Node.
import type { ImageTransformParams } from "./params";

/**
 * Who does the transforms. `worker` (default): WASM codecs in the Worker + variant in R2, with Cloudflare Images
 * only as fallback. `cloudflare`: operational kill switch → everything to Cloudflare Images like before (no
 * code redeploy, just the var).
 */
export const ImageTransformsMode = {
	WORKER: "worker",
	CLOUDFLARE: "cloudflare",
} as const;

export type ImageTransformsMode = (typeof ImageTransformsMode)[keyof typeof ImageTransformsMode];

/** Formats the Worker path knows how to decode (GIF/SVG/animated → always Cloudflare Images). */
export const WORKER_DECODABLE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

export type OutputFormat = "jpeg" | "png" | "webp" | "avif";

/**
 * Requested format, resolved WITHOUT reading the original (so the variant key works as a cache key before hitting R2):
 * either a concrete one, `source` (no `?format`: the original's own) or `baseline` (`auto` without webp/avif
 * support: whatever any browser can decode → PNG if the original is PNG, for the alpha; JPEG otherwise).
 */
export type RequestedFormat = OutputFormat | "source" | "baseline";

const MIME_BY_FORMAT: Record<OutputFormat, string> = {
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	avif: "image/avif",
};

const FORMAT_BY_MIME: Record<string, OutputFormat> = {
	"image/jpeg": "jpeg",
	"image/png": "png",
	"image/webp": "webp",
	"image/avif": "avif",
};

// Cloudflare Images defaults to 85 (jpeg/webp). AVIF: libavif's `quality` isn't the same scale;
// 50 is jSquash/Squoosh's default and gives a size/quality comparable to JPEG 85.
const DEFAULT_QUALITY: Record<OutputFormat, number> = { jpeg: 85, webp: 85, avif: 50, png: 100 };

/**
 * Default for the megapixel guard. Measured (bench/image-transforms/run-node.ts): the isolate's peak is
 * ≈ 14 MB/MP + ~25 MB fixed → 4 MP ≈ 80 MB, with margin for the rest of the Worker within the 128 MB.
 * Configurable with IMAGE_TRANSFORMS_MAX_MEGAPIXELS.
 */
export const DEFAULT_MAX_WORKER_MEGAPIXELS = 4;

/** Upscaling uses the WASM resize (heap ≈ 7x the input RGBA bytes, never freed) → small outputs only. */
export const MAX_WORKER_UPSCALE_MEGAPIXELS = 1;

/**
 * `format=auto` picks AVIF only if the output is small: AVIF costs 2-3x the CPU of WebP and at 1600 px it
 * goes over a second (bench). The area is estimated from the requested box (w×h, or side² with a single side) →
 * deterministic without reading the original. Without a size (re-encode at full size) it's never AVIF.
 */
export const AUTO_AVIF_MAX_PIXELS = 1024 * 1024;

export function resolveTransformsMode(raw: string | undefined): ImageTransformsMode {
	return raw === ImageTransformsMode.CLOUDFLARE ? ImageTransformsMode.CLOUDFLARE : ImageTransformsMode.WORKER;
}

export function parseMaxMegapixels(raw: string | undefined): number {
	const parsed = Number.parseFloat(raw ?? "");
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_WORKER_MEGAPIXELS;
}

export function mimeOfFormat(format: OutputFormat): string {
	return MIME_BY_FORMAT[format];
}

export function formatOfMime(contentType: string): OutputFormat | null {
	return FORMAT_BY_MIME[contentType] ?? null;
}

function estimatedOutputPixels(params: ImageTransformParams): number {
	const { width, height } = params;
	if (width && height) return width * height;
	const side = width ?? height;
	return side ? side * side : Number.POSITIVE_INFINITY;
}

const accepts = (accept: string | undefined, mime: string) => accept?.includes(mime) ?? false;

/** `auto` is negotiated with `Accept`: AVIF (only outputs ≤ ~1 MP) > WebP > baseline. Used by both paths. */
export function resolveRequestedFormat(params: ImageTransformParams, accept: string | undefined): RequestedFormat {
	if (!params.format) return "source";
	if (params.format !== "auto") return params.format as OutputFormat;
	const isSmallOutput = estimatedOutputPixels(params) <= AUTO_AVIF_MAX_PIXELS;
	if (isSmallOutput && accepts(accept, "image/avif")) return "avif";
	if (accepts(accept, "image/webp")) return "webp";
	return "baseline";
}

export function resolveOutputFormat(requested: RequestedFormat, sourceType: string): OutputFormat {
	if (requested === "baseline") return sourceType === "image/png" ? "png" : "jpeg";
	if (requested === "source") return formatOfMime(sourceType) ?? "jpeg";
	return requested;
}

export function outputQuality(params: ImageTransformParams, format: OutputFormat): number {
	return params.quality ?? DEFAULT_QUALITY[format];
}

/** Everything derived from an original (variants, mezzanine, and their L4 keys) lives under this prefix. */
export function variantPrefix(fullKey: string): string {
	return `${fullKey}/__variants/`;
}

export function isVariantKey(key: string): boolean {
	return key.includes("/__variants/");
}

/**
 * Variant key: UNDER the original's storage key → deleting the original sweeps it along and it stays under the same
 * storage prefix. Canonical params (fixed order, aliases resolved) and format already resolved → `?w=400` and
 * `?width=400` share a variant.
 */
export function variantStorageKey(fullKey: string, params: ImageTransformParams, requested: RequestedFormat): string {
	const canonical = [
		`w${params.width ?? ""}`,
		`h${params.height ?? ""}`,
		`fit-${params.fit ?? ""}`,
		`q${params.quality ?? ""}`,
	].join("_");
	return `${variantPrefix(fullKey)}${canonical}.${requested}`;
}

export interface Dimensions {
	width: number;
	height: number;
}

export interface ResizePlan {
	/** Centered crop of the original before scaling (`cover` only). */
	crop?: { x: number; y: number; width: number; height: number };
	/** Size of the scaled image. */
	width: number;
	height: number;
	/** Final canvas (`pad` only): the scaled image goes centered inside it. */
	canvas?: Dimensions;
}

/**
 * Geometry with `cf.image.fit`'s semantics: `scale-down` (default) doesn't upscale, `contain` fits (can
 * upscale), `cover` fills and crops to center, `pad` fits and pads up to w×h, `fill` stretches (= `squeeze`).
 */
export function planResize(source: Dimensions, params: ImageTransformParams): ResizePlan {
	const fit = params.fit ?? "scale-down";
	const target = targetBox(source, params);
	if (!target) return { width: source.width, height: source.height };

	if (fit === "fill") return target;
	if (fit === "cover") return planCover(source, target);

	const scale = Math.min(target.width / source.width, target.height / source.height);
	const boundedScale = fit === "scale-down" ? Math.min(1, scale) : scale;
	const scaled = {
		width: Math.max(1, Math.round(source.width * boundedScale)),
		height: Math.max(1, Math.round(source.height * boundedScale)),
	};
	if (fit !== "pad") return scaled;
	return { ...scaled, canvas: target };
}

// Requested box. With a single side given, the other comes from the original's aspect ratio.
function targetBox(source: Dimensions, params: ImageTransformParams): Dimensions | null {
	const { width, height } = params;
	if (width && height) return { width, height };
	if (width) return { width, height: Math.max(1, Math.round((source.height * width) / source.width)) };
	if (height) return { width: Math.max(1, Math.round((source.width * height) / source.height)), height };
	return null;
}

function planCover(source: Dimensions, target: Dimensions): ResizePlan {
	const targetAspect = target.width / target.height;
	const sourceAspect = source.width / source.height;
	const cropWidth = targetAspect > sourceAspect ? source.width : Math.round(source.height * targetAspect);
	const cropHeight = targetAspect > sourceAspect ? Math.round(source.width / targetAspect) : source.height;
	return {
		crop: {
			x: Math.floor((source.width - cropWidth) / 2),
			y: Math.floor((source.height - cropHeight) / 2),
			width: cropWidth,
			height: cropHeight,
		},
		width: target.width,
		height: target.height,
	};
}

export const megapixels = (size: Dimensions) => (size.width * size.height) / 1_000_000;

/** Does the plan upscale its source region (the `cover` crop, or the whole image)? */
export function isUpscale(source: Dimensions, plan: ResizePlan): boolean {
	const region = plan.crop ?? source;
	return plan.width > region.width || plan.height > region.height;
}

/**
 * Memory guard: does the transform fit in the isolate? Original, output, and `pad` canvas ≤ the cap; upscaling only
 * up to MAX_WORKER_UPSCALE_MEGAPIXELS. Above that → mezzanine or Cloudflare Images.
 */
export function fitsWorkerBudget(source: Dimensions, maxMegapixels: number, plan?: ResizePlan): boolean {
	if (megapixels(source) > maxMegapixels) return false;
	if (!plan) return true;
	if (megapixels(plan.canvas ?? plan) > maxMegapixels) return false;
	return !isUpscale(source, plan) || megapixels(plan) <= MAX_WORKER_UPSCALE_MEGAPIXELS;
}
