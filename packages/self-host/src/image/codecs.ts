// Pipeline decode → (crop) → resize → (pad) → encode with jSquash's (Squoosh) WASM codecs. It never imports
// the `.wasm` files: it receives them already compiled (`WebAssembly.Module`) → the Worker brings them in as
// static imports (wasm-modules.ts, bundled by wrangler) and Node/bench compiles them from disk. No Node APIs.
import avifDecode, { init as initAvifDecode } from "@jsquash/avif/decode";
import avifEncode, { init as initAvifEncode } from "@jsquash/avif/encode";
import jpegDecode, { init as initJpegDecode } from "@jsquash/jpeg/decode";
import jpegEncode, { init as initJpegEncode } from "@jsquash/jpeg/encode";
import pngDecode, { init as initPngDecode } from "@jsquash/png/decode";
import pngEncode, { init as initPngEncode } from "@jsquash/png/encode";
import resize, { initResize } from "@jsquash/resize";
import webpDecode, { init as initWebpDecode } from "@jsquash/webp/decode";
import webpEncode, { init as initWebpEncode } from "@jsquash/webp/encode";
import { areaDownscale } from "./area-resize";
import { type Dimensions, mimeOfFormat, type OutputFormat, type ResizePlan } from "./transform-plan";

export interface CodecWasmModules {
	jpegDec: WebAssembly.Module;
	jpegEnc: WebAssembly.Module;
	pngCodec: WebAssembly.Module;
	webpDec: WebAssembly.Module;
	webpEnc: WebAssembly.Module;
	avifDec: WebAssembly.Module;
	avifEnc: WebAssembly.Module;
	resize: WebAssembly.Module;
}

export interface EncodeTarget {
	format: OutputFormat;
	quality: number;
	/** AVIF: libavif speed 0 (slow) – 10 (fast). Default: AVIF_DEFAULT_SPEED. */
	avifSpeed?: number;
	/** JPEG/WebP: `fast` = JPEG baseline (no progressive) and WebP method 2. Default `fast` (see the bench). */
	effort?: "default" | "fast";
}

// Default chosen by the bench: speed 6 (jSquash's default) costs ~11x the CPU of speed 10 for ~5% fewer bytes.
export const AVIF_DEFAULT_SPEED = 8;

export interface TransformOutput {
	body: ArrayBuffer;
	contentType: string;
	width: number;
	height: number;
}

// workerd doesn't expose `ImageData` (it's a DOM type); the Emscripten/wasm-bindgen codecs instantiate it by global name.
class ImageDataShim {
	readonly colorSpace = "srgb";
	constructor(
		readonly data: Uint8ClampedArray,
		readonly width: number,
		readonly height: number,
	) {}
}

function ensureImageData(): void {
	const scope = globalThis as unknown as { ImageData?: unknown };
	if (!scope.ImageData) scope.ImageData = ImageDataShim;
}

// jSquash's `init` functions accept `(module)` even though their .d.ts only declares `(options)` → a targeted cast.
type ModuleInit = (module: WebAssembly.Module) => Promise<unknown>;
const asModuleInit = (init: unknown) => init as ModuleInit;

// Each Emscripten module (jpeg/webp/avif) starts with 16 MB of linear memory and WASM memory never
// shrinks: instantiating all 7 at once is ~98 MB claimed out of the isolate's 128 MB. That's why only the
// original's decoder and the output's encoder get instantiated, and FRESH on every transform: the previous
// instance (with its heap grown by the decode) is left without references and the GC frees it. png/resize
// (wasm-bindgen) don't support re-init → they're instantiated once (they start at 1 MB).
const EMSCRIPTEN_DECODERS: Record<string, [unknown, keyof CodecWasmModules]> = {
	"image/jpeg": [initJpegDecode, "jpegDec"],
	"image/webp": [initWebpDecode, "webpDec"],
	"image/avif": [initAvifDecode, "avifDec"],
};
const EMSCRIPTEN_ENCODERS: Partial<Record<OutputFormat, [unknown, keyof CodecWasmModules]>> = {
	jpeg: [initJpegEncode, "jpegEnc"],
	webp: [initWebpEncode, "webpEnc"],
	avif: [initAvifEncode, "avifEnc"],
};

let bindgenReady: Promise<unknown> | null = null;

export async function prepareCodecs(wasm: CodecWasmModules, sourceType: string, format: OutputFormat): Promise<void> {
	ensureImageData();
	bindgenReady ??= Promise.all([
		initResize(wasm.resize),
		asModuleInit(initPngDecode)(wasm.pngCodec),
		asModuleInit(initPngEncode)(wasm.pngCodec),
	]);
	const decoder = EMSCRIPTEN_DECODERS[sourceType];
	const encoder = EMSCRIPTEN_ENCODERS[format];
	await Promise.all([
		bindgenReady,
		decoder ? asModuleInit(decoder[0])(wasm[decoder[1]]) : null,
		encoder ? asModuleInit(encoder[0])(wasm[encoder[1]]) : null,
	]);
}

export async function decodeImage(bytes: ArrayBuffer, contentType: string): Promise<ImageData> {
	// Applies EXIF orientation (phone photos): without this the variant comes out rotated. The option's
	// name is misleading: `true` = rotate according to the tag.
	if (contentType === "image/jpeg") return jpegDecode(bytes, { preserveOrientation: true });
	if (contentType === "image/png") return pngDecode(bytes);
	if (contentType === "image/webp") return webpDecode(bytes);
	if (contentType === "image/avif") {
		const decoded = await avifDecode(bytes);
		if (!decoded) throw new Error("AVIF decode failed");
		return decoded as ImageData;
	}
	throw new Error(`Unsupported source type: ${contentType}`);
}

export interface ResizeOptions {
	method: "triangle" | "catrom" | "mitchell" | "lanczos3";
	/** Scale in linear light (more faithful, more expensive). */
	linearRGB: boolean;
}

// Only for upscaling (see resizeImage). lanczos3 in sRGB: linearRGB adds ~55% to the resize cost (bench).
export const DEFAULT_RESIZE_OPTIONS: ResizeOptions = { method: "lanczos3", linearRGB: false };

export type ResizeStrategy = "area" | "lanczos";

/**
 * Downscale → area average in JS over the crop window, without copying it (O(output) memory, see
 * area-resize.ts). Upscale (only `contain`/`pad`/`fill` with a box larger than the original, bounded by the guard) →
 * crop + lanczos3 WASM. `lanczos` forces WASM always (only for the bench and fixtures).
 */
export async function resizeImage(
	image: ImageData,
	plan: ResizePlan,
	options: ResizeOptions = DEFAULT_RESIZE_OPTIONS,
	strategy: ResizeStrategy = "area",
): Promise<ImageData> {
	const region = plan.crop ?? { x: 0, y: 0, width: image.width, height: image.height };
	const isSameSize = region.width === plan.width && region.height === plan.height;
	const isDownscale = plan.width <= region.width && plan.height <= region.height;
	const scaled =
		strategy === "area" && isDownscale && !isSameSize
			? makeImageData(areaDownscale(image, plan.width, plan.height, region), plan.width, plan.height)
			: await resizeWithWasm(image, plan, options);
	return plan.canvas ? padImage(scaled, plan.canvas) : scaled;
}

async function resizeWithWasm(image: ImageData, plan: ResizePlan, options: ResizeOptions): Promise<ImageData> {
	const cropped = plan.crop ? cropImage(image, plan.crop) : image;
	if (cropped.width === plan.width && cropped.height === plan.height) return cropped;
	return resize(cropped, { width: plan.width, height: plan.height, premultiply: true, ...options });
}

export async function encodeImage(image: ImageData, target: EncodeTarget): Promise<ArrayBuffer> {
	const isFast = (target.effort ?? "fast") === "fast";
	if (target.format === "jpeg") return jpegEncode(image, { quality: target.quality, progressive: !isFast });
	if (target.format === "webp") return webpEncode(image, { quality: target.quality, method: isFast ? 2 : 4 });
	if (target.format === "png") return pngEncode(image);
	return avifEncode(image, { quality: target.quality, speed: target.avifSpeed ?? AVIF_DEFAULT_SPEED });
}

/**
 * Full pipeline (what the route uses). The plan is built from the DECODED dimensions: with EXIF orientation
 * 90°/270° the header's width and height come swapped. The bench calls the stages separately.
 * `maxDecodedPixels`: the guard already decided using the header's dims; if the decode doesn't match (a
 * lying or truncated header), it bails out BEFORE allocating the resize/encode buffers.
 */
export async function transformImage(
	bytes: ArrayBuffer,
	contentType: string,
	planFor: (decoded: Dimensions) => ResizePlan,
	target: EncodeTarget,
	maxDecodedPixels = Number.POSITIVE_INFINITY,
): Promise<TransformOutput> {
	const decoded = await decodeImage(bytes, contentType);
	if (decoded.width * decoded.height > maxDecodedPixels) {
		throw new Error(`Decoded ${decoded.width}x${decoded.height} exceeds the header-checked budget`);
	}
	const resized = await resizeImage(decoded, planFor(decoded));
	const body = await encodeImage(resized, target);
	return { body, contentType: mimeOfFormat(target.format), width: resized.width, height: resized.height };
}

function makeImageData(data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): ImageData {
	const Ctor = (globalThis as unknown as { ImageData: typeof ImageData }).ImageData;
	return new Ctor(data, width, height);
}

function cropImage(image: ImageData, crop: NonNullable<ResizePlan["crop"]>): ImageData {
	const source = new Uint32Array(image.data.buffer, image.data.byteOffset, image.width * image.height);
	const target = new Uint32Array(crop.width * crop.height);
	for (let row = 0; row < crop.height; row += 1) {
		const start = (row + crop.y) * image.width + crop.x;
		target.set(source.subarray(start, start + crop.width), row * crop.width);
	}
	return makeImageData(new Uint8ClampedArray(target.buffer), crop.width, crop.height);
}

// Opaque white canvas (used for JPEG); the scaled image goes centered.
function padImage(image: ImageData, canvas: Dimensions): ImageData {
	const target = new Uint32Array(canvas.width * canvas.height).fill(0xffffffff);
	const source = new Uint32Array(image.data.buffer, image.data.byteOffset, image.width * image.height);
	const offsetX = Math.floor((canvas.width - image.width) / 2);
	const offsetY = Math.floor((canvas.height - image.height) / 2);
	for (let row = 0; row < image.height; row += 1) {
		target.set(source.subarray(row * image.width, (row + 1) * image.width), (row + offsetY) * canvas.width + offsetX);
	}
	return makeImageData(new Uint8ClampedArray(target.buffer), canvas.width, canvas.height);
}
