// Support for transform tests (tests only): an in-memory R2, the media route mounted, and the codecs'
// `.wasm` files compiled from disk (in the Worker, wrangler delivers them as static imports).
import {
	encodeEncryptionMeta,
	encryptBytes,
	exportEncryptionKey,
	generateEncryptionKey,
	generateIv,
} from "@devultur/core";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Hono } from "hono";
import { signViewerToken } from "../helpers";
import { updateRequestState } from "../request-state";
import { media } from "../routes/media";
import type { WorkerApp } from "../types";
import type { CodecWasmModules } from "./codecs";

const WASM_PATHS: Record<keyof CodecWasmModules, string> = {
	jpegDec: "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
	jpegEnc: "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm",
	pngCodec: "@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
	webpDec: "@jsquash/webp/codec/dec/webp_dec.wasm",
	webpEnc: "@jsquash/webp/codec/enc/webp_enc_simd.wasm",
	avifDec: "@jsquash/avif/codec/dec/avif_dec.wasm",
	avifEnc: "@jsquash/avif/codec/enc/avif_enc.wasm",
	resize: "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm",
};

/** Replacement for `./wasm-modules` for `vi.mock`: the same `.wasm` files, compiled from node_modules. */
export async function diskWasmModules(): Promise<{ codecWasmModules: CodecWasmModules }> {
	const require = createRequire(import.meta.url);
	const entries = await Promise.all(
		Object.entries(WASM_PATHS).map(async ([name, specifier]) => [
			name,
			await WebAssembly.compile(await readFile(require.resolve(specifier))),
		]),
	);
	return { codecWasmModules: Object.fromEntries(entries) };
}

export interface StoredObject {
	body: Uint8Array<ArrayBuffer>;
	contentType: string;
	customMetadata: Record<string, string>;
}

interface PutOptions {
	httpMetadata?: { contentType?: string };
	customMetadata?: Record<string, string>;
}

/** In-memory R2 with just what the route uses: get (+range), put, head, delete, list. */
export function memoryBucket() {
	const objects = new Map<string, StoredObject>();
	const toR2 = (key: string, stored: StoredObject, slice = stored.body) => ({
		key,
		size: stored.body.byteLength,
		httpEtag: `"${key.length}"`,
		httpMetadata: { contentType: stored.contentType },
		customMetadata: stored.customMetadata,
		body: new Response(slice).body,
		arrayBuffer: async () => slice.slice().buffer,
	});
	return {
		objects,
		async get(key: string, options?: { range?: { offset: number; length: number } }) {
			const stored = objects.get(key);
			if (!stored) return null;
			const range = options?.range;
			return toR2(key, stored, range ? stored.body.subarray(range.offset, range.offset + range.length) : stored.body);
		},
		async head(key: string) {
			const stored = objects.get(key);
			return stored ? { key, customMetadata: stored.customMetadata } : null;
		},
		async put(key: string, body: ArrayBuffer | Uint8Array, options?: PutOptions) {
			const bytes = new Uint8Array(body instanceof Uint8Array ? body.slice() : body.slice(0));
			objects.set(key, {
				body: bytes,
				contentType: options?.httpMetadata?.contentType ?? "",
				customMetadata: options?.customMetadata ?? {},
			});
			return { key };
		},
		async delete(keys: string | string[]) {
			for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
		},
		async list({ prefix }: { prefix: string }) {
			const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
			return { objects: keys.map((key) => ({ key, size: objects.get(key)?.body.byteLength ?? 0 })), truncated: false };
		},
	};
}

export type MemoryBucket = ReturnType<typeof memoryBucket>;

export const DELIVERY_SECRET = "delivery-secret";

/** The media route mounted at `/v1/media` with `env`. Returns a `request(path, init)`. */
export function mediaApp(env: Record<string, unknown>) {
	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		updateRequestState(context, { storagePrefix: "" });
		await next();
	});
	app.route("/v1/media", media);
	const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };
	const fullEnv = { DELIVERY_SIGN_SECRET: DELIVERY_SECRET, ...env };
	return (path: string, init: RequestInit = {}) =>
		app.request(`https://media.test${path}`, init, fullEnv, executionCtx as unknown as ExecutionContext);
}

export function viewerToken(): Promise<string> {
	return signViewerToken({ sub: "u", exp: Math.floor(Date.now() / 1000) + 60 }, DELIVERY_SECRET);
}

/** Stores `plaintext` encrypted (L4) the way an upload leaves it: key in KEYS_BUCKET under `${key}/${keyId}`. */
export async function putEncrypted(
	bucket: MemoryBucket,
	keys: MemoryBucket,
	key: string,
	plaintext: Uint8Array<ArrayBuffer>,
	contentType: string,
): Promise<void> {
	const cryptoKey = await generateEncryptionKey();
	const iv = generateIv();
	await keys.put(`${key}/key0`, await exportEncryptionKey(cryptoKey));
	await bucket.put(key, await encryptBytes(plaintext, cryptoKey, iv), {
		httpMetadata: { contentType },
		customMetadata: { enc: encodeEncryptionMeta(iv, "key0") },
	});
}

/** A real JPEG of `width`×`height` with a gradient (the codecs need to be prepared for jpeg). */
export async function sampleJpeg(width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
	const [{ prepareCodecs, encodeImage }, { codecWasmModules }] = await Promise.all([
		import("./codecs"),
		import("./wasm-modules"),
	]);
	await prepareCodecs(codecWasmModules, "image/jpeg", "jpeg");
	const pixels = new Uint8ClampedArray(width * height * 4);
	for (let index = 0; index < width * height; index += 1) {
		pixels.set([index % 255, (index * 3) % 255, (index * 7) % 255, 255], index * 4);
	}
	const image = { data: pixels, width, height, colorSpace: "srgb" } as ImageData;
	return new Uint8Array(await encodeImage(image, { format: "jpeg", quality: 85 }));
}

/** Width×height of the served JPEG (SOF), to verify geometry without decoding. */
export async function servedSize(response: Response): Promise<{ width: number; height: number } | null> {
	const { readImageDimensions } = await import("./dimensions");
	const bytes = new Uint8Array(await response.arrayBuffer());
	return readImageDimensions(bytes, response.headers.get("Content-Type") ?? "");
}
