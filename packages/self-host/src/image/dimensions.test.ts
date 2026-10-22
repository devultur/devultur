import { describe, expect, it } from "vitest";
import { isAnimatedImage, readImageDimensions } from "./dimensions";

function jpegHeader(width: number, height: number): Uint8Array {
	// SOI, APP0 (len 4 → 2 bytes de payload), SOF0 (len 11): precision, height, width.
	return new Uint8Array([
		0xff,
		0xd8,
		0xff,
		0xe0,
		0x00,
		0x04,
		0x00,
		0x00,
		0xff,
		0xc0,
		0x00,
		0x0b,
		0x08,
		height >> 8,
		height & 0xff,
		width >> 8,
		width & 0xff,
		0x03,
		0x00,
		0x00,
		0x00,
	]);
}

function pngHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(24);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(bytes.buffer).setUint32(16, width);
	new DataView(bytes.buffer).setUint32(20, height);
	return bytes;
}

describe("readImageDimensions", () => {
	it("reads JPEG SOF after other segments", () => {
		expect(readImageDimensions(jpegHeader(4032, 3024), "image/jpeg")).toEqual({ width: 4032, height: 3024 });
	});

	it("reads PNG IHDR", () => {
		expect(readImageDimensions(pngHeader(1732, 1155), "image/png")).toEqual({ width: 1732, height: 1155 });
	});

	it("reads the three WebP chunk layouts (VP8X, lossy VP8, lossless VP8L)", () => {
		expect(
			readImageDimensions(webpHeader("VP8X", [0, 0, 0, 0, 0, 0, 0, 0, 0x7f, 0x07, 0, 0x37, 0x04, 0]), "image/webp"),
		).toEqual({ width: 1920, height: 1080 });
		expect(
			readImageDimensions(webpHeader("VP8 ", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x80, 0x02, 0xe0, 0x01]), "image/webp"),
		).toEqual({ width: 640, height: 480 });
		// 14 bits of width - 1 (99), then 14 bits of height - 1 (49).
		const losslessBits = 99 | (49 << 14);
		const lossless = [0, 0, 0, 0, 0, losslessBits & 0xff, (losslessBits >> 8) & 0xff, (losslessBits >> 16) & 0xff, 0];
		expect(readImageDimensions(webpHeader("VP8L", [...lossless, 0, 0, 0, 0, 0]), "image/webp")).toEqual({
			width: 100,
			height: 50,
		});
	});

	it("reads AVIF's ispe box", () => {
		const bytes = new Uint8Array(64);
		bytes.set([...ascii("ispe"), 0, 0, 0, 0], 24);
		new DataView(bytes.buffer).setUint32(32, 3840);
		new DataView(bytes.buffer).setUint32(36, 2160);
		expect(readImageDimensions(bytes, "image/avif")).toEqual({ width: 3840, height: 2160 });
	});

	it("reads GIF87a and GIF89a logical screens", () => {
		expect(readImageDimensions(gifHeader("GIF89a", 320, 240), "image/gif")).toEqual({ width: 320, height: 240 });
		expect(readImageDimensions(gifHeader("GIF87a", 16, 9), "image/gif")).toEqual({ width: 16, height: 9 });
	});

	it("returns null for unknown or corrupt headers", () => {
		expect(readImageDimensions(new Uint8Array([1, 2, 3]), "image/jpeg")).toBeNull();
		expect(readImageDimensions(pngHeader(1, 1), "image/gif")).toBeNull();
		expect(readImageDimensions(gifHeader("GIF89a", 1, 1), "image/svg+xml")).toBeNull();
	});
});

function webpHeader(chunk: string, payload: number[]): Uint8Array {
	const bytes = new Uint8Array(30);
	bytes.set([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii(chunk), ...payload]);
	return bytes;
}

function gifHeader(signature: string, width: number, height: number): Uint8Array {
	return new Uint8Array([...ascii(signature), width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0, 0]);
}

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

function pngWithChunk(chunk: string): Uint8Array {
	const ihdr = [0, 0, 0, 13, ...ascii("IHDR"), ...new Array(13).fill(0), 0, 0, 0, 0];
	const extra = [0, 0, 0, 0, ...ascii(chunk), 0, 0, 0, 0];
	return new Uint8Array([0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...extra]);
}

function webpExtended(flags: number): Uint8Array {
	const bytes = new Uint8Array(30);
	bytes.set([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBPVP8X"), 10, 0, 0, 0, flags]);
	return bytes;
}

function avifWithBrands(...brands: string[]): Uint8Array {
	const size = 16 + brands.length * 4;
	return new Uint8Array([0, 0, 0, size, ...ascii("ftyp"), ...ascii("avif"), 0, 0, 0, 0, ...brands.flatMap(ascii)]);
}

describe("isAnimatedImage", () => {
	it("detects APNG, animated WebP and AVIF sequences", () => {
		expect(isAnimatedImage(pngWithChunk("acTL"), "image/png")).toBe(true);
		expect(isAnimatedImage(webpExtended(0x02), "image/webp")).toBe(true);
		expect(isAnimatedImage(avifWithBrands("mif1", "avis"), "image/avif")).toBe(true);
		expect(isAnimatedImage(new Uint8Array(), "image/gif")).toBe(true);
	});

	it("treats still images as static", () => {
		expect(isAnimatedImage(pngWithChunk("IDAT"), "image/png")).toBe(false);
		expect(isAnimatedImage(webpExtended(0x10), "image/webp")).toBe(false);
		expect(isAnimatedImage(avifWithBrands("mif1", "miaf"), "image/avif")).toBe(false);
		expect(isAnimatedImage(jpegHeader(10, 10), "image/jpeg")).toBe(false);
	});
});
