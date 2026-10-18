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

	it("returns null for unknown or corrupt headers", () => {
		expect(readImageDimensions(new Uint8Array([1, 2, 3]), "image/jpeg")).toBeNull();
		expect(readImageDimensions(pngHeader(1, 1), "image/gif")).toBeNull();
	});
});

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
