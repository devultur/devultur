// Transform done in the Worker and persisted as a VARIANT in R2: each unique transform is computed once and
// then served like any object (Range, edge cache, L4). Originals above the guard go through a
// mezzanine (mezzanine.ts). Whatever doesn't fit (animated, GIF, codec failures) → `fallback` and the route uses
// Cloudflare Images for THAT request.
import type { WorkerEnv } from "../types";
import type { ImageOrigin } from "./cloudflare";
import { isAnimatedImage, readImageDimensions } from "./dimensions";
import { canServeFromMezzanine, type DecodableSource, resolveMezzanine } from "./mezzanine";
import type { ImageTransformParams } from "./params";
import { DerivedKind, loadDecryptor, readHeaderBytes, readWholeObject, storeDerived } from "./storage";
import {
	type Dimensions,
	fitsWorkerBudget,
	megapixels,
	type OutputFormat,
	outputQuality,
	parseMaxMegapixels,
	planResize,
	resolveOutputFormat,
	resolveRequestedFormat,
	variantStorageKey,
	WORKER_DECODABLE_TYPES,
} from "./transform-plan";

// An original larger than this isn't downloaded whole even if its dims fit: it goes through the mezzanine.
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

export type WorkerVariant =
	| { kind: "variant"; storageKey: string; object: R2ObjectBody; generated: boolean }
	| { kind: "fallback"; reason: string };

type Fallback = Extract<WorkerVariant, { kind: "fallback" }>;

const fallback = (reason: string): Fallback => ({ kind: "fallback", reason });

export interface WorkerVariantRequest {
	env: WorkerEnv;
	/** Storage key (with the storage prefix) of the original. */
	fullKey: string;
	original: R2ObjectBody;
	params: ImageTransformParams;
	accept: string | undefined;
	/** The original for Cloudflare, in case the mezzanine needs to be requested. */
	origin: ImageOrigin;
}

/** Variant key without touching R2 (also works as the edge's cache key). */
export function workerVariantKey(fullKey: string, params: ImageTransformParams, accept: string | undefined): string {
	return variantStorageKey(fullKey, params, resolveRequestedFormat(params, accept));
}

export async function resolveWorkerVariant(request: WorkerVariantRequest): Promise<WorkerVariant> {
	const storageKey = workerVariantKey(request.fullKey, request.params, request.accept);
	const existing = await request.env.MEDIA_BUCKET.get(storageKey);
	if (existing) return { kind: "variant", storageKey, object: existing, generated: false };

	// Any failure in the path (codec, memory, R2, Cloudflare) doesn't break the request: it falls back to Cloudflare Images.
	try {
		return await generateVariant(request, storageKey);
	} catch (error) {
		console.error("[image-transforms] worker path failed:", error);
		return fallback(`error:${error instanceof Error ? error.name : "unknown"}`);
	}
}

async function generateVariant(request: WorkerVariantRequest, storageKey: string): Promise<WorkerVariant> {
	const { env, fullKey, original, params } = request;
	const sourceType = original.httpMetadata?.contentType ?? "";
	if (!WORKER_DECODABLE_TYPES.has(sourceType)) return fallback(`type:${sourceType}`);

	const decrypt = await loadDecryptor(env, fullKey, original.customMetadata);
	if (!decrypt) return fallback("decryption_key_unavailable");

	// HEADER dims before downloading or decoding anything: file size doesn't bound the pixel count.
	const header = await readHeaderBytes(env, fullKey, original, decrypt);
	const dimensions = header ? readImageDimensions(header, sourceType) : null;
	if (!header || !dimensions) return fallback("unreadable_header");
	if (isAnimatedImage(header, sourceType)) return fallback("animated");

	const maxMegapixels = parseMaxMegapixels(env.IMAGE_TRANSFORMS_MAX_MEGAPIXELS);
	const isWithinBudget = megapixels(dimensions) <= maxMegapixels && original.size <= MAX_SOURCE_BYTES;
	const source = isWithinBudget
		? { bytes: await readWholeObject(original, decrypt), contentType: sourceType, dimensions }
		: await mezzanineSource(request, dimensions, maxMegapixels);
	if ("reason" in source) return source;

	const plan = planResize(source.dimensions, params);
	if (!fitsWorkerBudget(source.dimensions, maxMegapixels, plan)) return fallback("megapixels");

	const format = resolveOutputFormat(resolveRequestedFormat(params, request.accept), sourceType);
	const output = await oneAtATime(() => runCodecs(source, params, format));
	await storeDerived(env, storageKey, output.body, output.contentType, original, DerivedKind.VARIANT);

	const stored = await env.MEDIA_BUCKET.get(storageKey);
	if (!stored) return fallback("variant_write_lost");
	return { kind: "variant", storageKey, object: stored, generated: true };
}

async function mezzanineSource(
	request: WorkerVariantRequest,
	originalDimensions: Dimensions,
	maxMegapixels: number,
): Promise<DecodableSource | Fallback> {
	const { env, fullKey, original, origin, params } = request;
	const mezzanine = await resolveMezzanine({ env, fullKey, original, originalDimensions, origin, maxMegapixels });
	if (mezzanine.kind === "fallback") return mezzanine;
	if (!canServeFromMezzanine(originalDimensions, mezzanine.source.dimensions, params)) {
		return fallback("beyond_mezzanine");
	}
	return mezzanine.source;
}

// An isolate serves concurrent requests and the memory budget is PER isolate: two 4 MP decodes at the
// same time don't fit. They're serialized (an in-memory queue on the isolate); other requests keep going without waiting.
let transformQueue: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
	const run = transformQueue.then(task, task);
	transformQueue = run.catch(() => undefined);
	return run;
}

// The codecs (≈ 6 MB of WASM) load with `import()`: the bundle includes them, but Node/vitest never evaluates
// the `.wasm` imports unless this path runs.
async function runCodecs(source: DecodableSource, params: ImageTransformParams, format: OutputFormat) {
	const [{ prepareCodecs, transformImage }, { codecWasmModules }] = await Promise.all([
		import("./codecs"),
		import("./wasm-modules"),
	]);
	await prepareCodecs(codecWasmModules, source.contentType, format);
	const headerPixels = source.dimensions.width * source.dimensions.height;
	return transformImage(
		source.bytes.buffer,
		source.contentType,
		(decoded) => planResize(decoded, params),
		{ format, quality: outputQuality(params, format) },
		headerPixels,
	);
}
