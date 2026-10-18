// Reads width/height from the header WITHOUT decoding → the megapixel guard decides before allocating the RGBA buffer
// (file size says nothing: a 1 MB PNG can be 100 MP). JPEG (SOFn), PNG (IHDR), WebP
// (VP8/VP8L/VP8X), AVIF (`ispe`). Null = unrecognized → fallback. Also detects animation (→ Cloudflare).
import type { Dimensions } from "./transform-plan";

export function readImageDimensions(bytes: Uint8Array, contentType: string): Dimensions | null {
	if (contentType === "image/jpeg") return readJpeg(bytes);
	if (contentType === "image/png") return readPng(bytes);
	if (contentType === "image/webp") return readWebp(bytes);
	if (contentType === "image/avif") return readAvif(bytes);
	return null;
}

const uint16BE = (bytes: Uint8Array, offset: number) => (bytes[offset] << 8) | bytes[offset + 1];
const uint32BE = (bytes: Uint8Array, offset: number) =>
	((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
const uint16LE = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8);
const uint24LE = (bytes: Uint8Array, offset: number) =>
	bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);

// Markers SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC), which share the range.
const isStartOfFrame = (marker: number) =>
	marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function readJpeg(bytes: Uint8Array): Dimensions | null {
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	let offset = 2;
	while (offset + 9 < bytes.length) {
		if (bytes[offset] !== 0xff) return null;
		const marker = bytes[offset + 1];
		if (isStartOfFrame(marker)) {
			return { height: uint16BE(bytes, offset + 5), width: uint16BE(bytes, offset + 7) };
		}
		offset += 2 + uint16BE(bytes, offset + 2);
	}
	return null;
}

function readPng(bytes: Uint8Array): Dimensions | null {
	const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
	if (!isPng || bytes.length < 24) return null;
	return { width: uint32BE(bytes, 16), height: uint32BE(bytes, 20) };
}

function readWebp(bytes: Uint8Array): Dimensions | null {
	if (bytes.length < 30) return null;
	const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
	if (chunk === "VP8X") return { width: uint24LE(bytes, 24) + 1, height: uint24LE(bytes, 27) + 1 };
	if (chunk === "VP8 ") return { width: uint16LE(bytes, 26) & 0x3fff, height: uint16LE(bytes, 28) & 0x3fff };
	if (chunk === "VP8L") {
		const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	return null;
}

// AVIF: the first `ispe` box (image spatial extents) inside `meta/iprp/ipco`. Linear search bounded to
// the first few KB — enough for a static AVIF's header.
function readAvif(bytes: Uint8Array): Dimensions | null {
	const limit = Math.min(bytes.length - 20, 64 * 1024);
	for (let offset = 4; offset < limit; offset += 1) {
		const isIspe =
			bytes[offset] === 0x69 && bytes[offset + 1] === 0x73 && bytes[offset + 2] === 0x70 && bytes[offset + 3] === 0x65;
		if (isIspe) return { width: uint32BE(bytes, offset + 8), height: uint32BE(bytes, offset + 12) };
	}
	return null;
}

const fourCC = (bytes: Uint8Array, offset: number) =>
	String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);

/**
 * Is it animated? The Worker path only decodes the first frame → an animation goes to Cloudflare whole. WebP:
 * animation flag of the VP8X. PNG (APNG): `acTL` chunk before the first `IDAT`. AVIF: `avis` brand in the `ftyp`.
 */
export function isAnimatedImage(bytes: Uint8Array, contentType: string): boolean {
	if (contentType === "image/gif") return true;
	if (contentType === "image/webp")
		return bytes.length > 20 && fourCC(bytes, 12) === "VP8X" && (bytes[20] & 0x02) !== 0;
	if (contentType === "image/png") return hasPngAnimationControl(bytes);
	if (contentType === "image/avif") return hasAvifSequenceBrand(bytes);
	return false;
}

function hasPngAnimationControl(bytes: Uint8Array): boolean {
	let offset = 8;
	while (offset + 8 <= bytes.length) {
		const chunk = fourCC(bytes, offset + 4);
		if (chunk === "acTL") return true;
		if (chunk === "IDAT") return false;
		offset += 12 + uint32BE(bytes, offset);
	}
	return false;
}

function hasAvifSequenceBrand(bytes: Uint8Array): boolean {
	if (bytes.length < 16 || fourCC(bytes, 4) !== "ftyp") return false;
	const boxEnd = Math.min(uint32BE(bytes, 0), bytes.length);
	for (let offset = 8; offset + 4 <= boxEnd; offset += 4) {
		if (offset === 12) continue; // minor_version, not a brand
		if (fourCC(bytes, offset) === "avis") return true;
	}
	return false;
}
