/// <reference path="./wasm.d.ts" />
// The codecs' `.wasm` files as static imports → wrangler (esbuild, default CompiledWasm rule)
// uploads them as Worker modules and they arrive here already compiled (`WebAssembly.Module`). Only loaded with
// `import()` when a transform runs in the Worker: in Node/vitest the tests replace it with a mock.
import avifDec from "@jsquash/avif/codec/dec/avif_dec.wasm";
import avifEnc from "@jsquash/avif/codec/enc/avif_enc.wasm";
import jpegDec from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
import jpegEnc from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm";
// @ts-expect-error -- wasm-bindgen's .d.ts describes the exports; wrangler delivers the Module as default.
import pngCodec from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
// @ts-expect-error -- same as above.
import resize from "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm";
import webpDec from "@jsquash/webp/codec/dec/webp_dec.wasm";
// workerd supports WASM SIMD → jSquash picks the `webp_enc_simd.js` glue; the binary has to be the same build.
import webpEnc from "@jsquash/webp/codec/enc/webp_enc_simd.wasm";
import type { CodecWasmModules } from "./codecs";

export const codecWasmModules: CodecWasmModules = {
	jpegDec,
	jpegEnc,
	pngCodec,
	webpDec,
	webpEnc,
	avifDec,
	avifEnc,
	resize,
};
