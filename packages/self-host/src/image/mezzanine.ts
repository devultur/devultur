// Mezzanine: for an original above the megapixel guard, Cloudflare Images generates ONE master
// ≤ the cap (`{fullKey}/__variants/mezzanine.{jpeg|webp}`) and all variants come from it, in the Worker.
// Cloudflare then charges one transform per large original (just once), not one per variant per month.
import type { WorkerEnv } from "../types";
import { fetchCloudflareImage, type ImageOrigin } from "./cloudflare";
import { isAnimatedImage, readImageDimensions } from "./dimensions";
import type { ImageTransformParams } from "./params";
import { DerivedKind, loadDecryptor, storeDerived } from "./storage";
import { type Dimensions, isUpscale, megapixels, mimeOfFormat, planResize, variantPrefix } from "./transform-plan";

// High quality: the mezzanine is the source for all variants, so its loss gets inherited.
const MEZZANINE_QUALITY = 90;
// Margin so Cloudflare's rounding doesn't leave the master just barely above the cap.
const MEZZANINE_PIXEL_HEADROOM = 0.98;

export interface DecodableSource {
	bytes: Uint8Array<ArrayBuffer>;
	contentType: string;
	dimensions: Dimensions;
}

export type MezzanineResult =
	| { kind: "mezzanine"; source: DecodableSource; created: boolean }
	| { kind: "fallback"; reason: string };

export interface MezzanineRequest {
	env: WorkerEnv;
	fullKey: string;
	original: R2Object;
	originalDimensions: Dimensions;
	origin: ImageOrigin;
	maxMegapixels: number;
}

/** JPEG for JPEG originals (the decoder measured in the bench); WebP for the rest, which may carry alpha. */
export function mezzanineFormat(sourceType: string): "jpeg" | "webp" {
	return sourceType === "image/jpeg" ? "jpeg" : "webp";
}

export function mezzanineKey(fullKey: string, sourceType: string): string {
	return `${variantPrefix(fullKey)}mezzanine.${mezzanineFormat(sourceType)}`;
}

/**
 * Master's long side. We ask Cloudflare for a SQUARE box of that side with `scale-down`: Cloudflare applies
 * EXIF orientation before fitting, so a square box gives the same master with or without rotation.
 */
export function mezzanineLongSide(original: Dimensions, maxMegapixels: number): number {
	const budgetPixels = maxMegapixels * 1_000_000 * MEZZANINE_PIXEL_HEADROOM;
	const scale = Math.min(1, Math.sqrt(budgetPixels / (original.width * original.height)));
	return Math.max(1, Math.floor(Math.max(original.width, original.height) * scale));
}

const isLandscape = (size: Dimensions) => size.width >= size.height;

/**
 * Does the mezzanine produce the SAME output the original would? Not if the master needs upscaling (it would lose
 * detail the original actually has), nor if `scale-down` caps at the master's size. In those cases the request goes
 * entirely to Cloudflare. The original is oriented like the master (the header's dims precede EXIF rotation).
 */
export function canServeFromMezzanine(
	original: Dimensions,
	mezzanine: Dimensions,
	params: ImageTransformParams,
): boolean {
	const oriented =
		isLandscape(original) === isLandscape(mezzanine) ? original : { width: original.height, height: original.width };
	const fromOriginal = planResize(oriented, params);
	const fromMezzanine = planResize(mezzanine, params);
	if (isUpscale(mezzanine, fromMezzanine)) return false;
	const isSameWidth = Math.abs(fromOriginal.width - fromMezzanine.width) <= 1;
	return isSameWidth && Math.abs(fromOriginal.height - fromMezzanine.height) <= 1;
}

// Concurrent requests for the same original within an isolate share the generation. Across isolates there can be a
// duplicate mezzanine (both valid; the last PUT wins), never a corrupt one: it's validated before storing.
const inFlight = new Map<string, Promise<MezzanineResult>>();

export function resolveMezzanine(request: MezzanineRequest): Promise<MezzanineResult> {
	const key = mezzanineKey(request.fullKey, request.original.httpMetadata?.contentType ?? "");
	const pending = inFlight.get(key);
	if (pending) return pending;
	const run = loadOrCreate(request, key).finally(() => inFlight.delete(key));
	inFlight.set(key, run);
	return run;
}

async function loadOrCreate(request: MezzanineRequest, key: string): Promise<MezzanineResult> {
	const stored = await readStoredMezzanine(request.env, key, request.maxMegapixels);
	if (stored) return { kind: "mezzanine", source: stored, created: false };
	return createMezzanine(request, key);
}

// An unreadable or over-budget mezzanine is treated as absent → it gets regenerated on top.
async function readStoredMezzanine(env: WorkerEnv, key: string, maxMegapixels: number) {
	const object = await env.MEDIA_BUCKET.get(key);
	if (!object) return null;
	const decrypt = await loadDecryptor(env, key, object.customMetadata);
	if (!decrypt) return null;
	const bytes = await decrypt(new Uint8Array(await object.arrayBuffer()));
	return validMezzanine(bytes, object.httpMetadata?.contentType ?? "", maxMegapixels);
}

async function createMezzanine(request: MezzanineRequest, key: string): Promise<MezzanineResult> {
	const { env, original, originalDimensions, maxMegapixels } = request;
	const format = mezzanineFormat(original.httpMetadata?.contentType ?? "");
	const longSide = mezzanineLongSide(originalDimensions, maxMegapixels);
	const response = await fetchCloudflareImage(request.origin, env.DELIVERY_SIGN_SECRET, {
		width: longSide,
		height: longSide,
		fit: "scale-down",
		format,
		quality: MEZZANINE_QUALITY,
		"origin-auth": "share-publicly",
	});
	if (!response.ok) return { kind: "fallback", reason: `mezzanine_status:${response.status}` };

	const bytes = new Uint8Array(await response.arrayBuffer());
	const declaredLength = response.headers.get("content-length");
	if (declaredLength && Number(declaredLength) !== bytes.byteLength) {
		return { kind: "fallback", reason: "mezzanine_truncated" };
	}
	// If Cloudflare couldn't transform it, it returns the original as is: a different type or dims out of budget.
	const contentType = mimeOfFormat(format);
	if (!response.headers.get("content-type")?.startsWith(contentType)) {
		return { kind: "fallback", reason: "mezzanine_type" };
	}
	const source = validMezzanine(bytes, contentType, maxMegapixels);
	if (!source) return { kind: "fallback", reason: "mezzanine_invalid" };

	await storeDerived(env, key, bytes.buffer, contentType, original, DerivedKind.MEZZANINE);
	console.log(`[image-transforms] mezzanine created ${source.dimensions.width}x${source.dimensions.height}`);
	return { kind: "mezzanine", source, created: true };
}

function validMezzanine(
	bytes: Uint8Array<ArrayBuffer>,
	contentType: string,
	maxMegapixels: number,
): DecodableSource | null {
	const dimensions = readImageDimensions(bytes, contentType);
	if (!dimensions || megapixels(dimensions) > maxMegapixels) return null;
	if (isAnimatedImage(bytes, contentType)) return null;
	return { bytes, contentType, dimensions };
}
