// Content sniffing: do the first bytes of an upload match the Content-Type it declares? A hand-rolled signature table
// (no dependency, nothing parsed past a few fixed offsets) for the types the Worker serves inline. A type outside the
// table is `unverifiable`: it keeps its declared type, and delivery already sandboxes the risky ones.
// Scriptable content (HTML, SVG, XML) is checked first, so a "PDF", "image" or "text" upload that is really a document
// a browser would run is always a mismatch. The sniff never upgrades a type into a scriptable one.

/** Bytes the sniff reads: enough for every signature below (the WHATWG sniffing header is 1445). */
export const SNIFF_HEAD_BYTES = 4096;

export type SniffResult =
	| { verdict: "match" }
	| { verdict: "mismatch"; detected: string }
	| { verdict: "unverifiable" };

type Signature = (head: Uint8Array) => boolean;

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

function hasBytesAt(head: Uint8Array, offset: number, bytes: number[]): boolean {
	if (head.length < offset + bytes.length) return false;
	return bytes.every((byte, index) => head[offset + index] === byte);
}

function readAscii(head: Uint8Array, start: number, end: number): string {
	return String.fromCharCode(...head.subarray(start, Math.min(end, head.length)));
}

const startsWith =
	(...bytes: number[]): Signature =>
	(head) =>
		hasBytesAt(head, 0, bytes);

/** `RIFF <size> <form>`: WebP, WAV. */
const riff =
	(form: string): Signature =>
	(head) =>
		hasBytesAt(head, 0, ascii("RIFF")) && hasBytesAt(head, 8, ascii(form));

const PDF_HEADER = ascii("%PDF-");
// The PDF spec allows the header anywhere in the first 1024 bytes.
const isPdf: Signature = (head) => {
	const searchEnd = Math.min(head.length, 1024) - PDF_HEADER.length;
	for (let offset = 0; offset <= searchEnd; offset++) {
		if (hasBytesAt(head, offset, PDF_HEADER)) return true;
	}
	return false;
};

// ISO-BMFF (`ftyp` box at offset 4): its major brand and the compatible brands that follow.
function ftypBrands(head: Uint8Array): string[] | null {
	if (!hasBytesAt(head, 4, ascii("ftyp"))) return null;
	const boxSize = ((head[0] ?? 0) << 24) | ((head[1] ?? 0) << 16) | ((head[2] ?? 0) << 8) | (head[3] ?? 0);
	const boxEnd = Math.min(boxSize >= 16 ? boxSize : 16, head.length);
	const brands = [readAscii(head, 8, 12)];
	for (let offset = 16; offset + 4 <= boxEnd; offset += 4) brands.push(readAscii(head, offset, offset + 4));
	return brands;
}

const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]);
// Old QuickTime files have no `ftyp`: their first atom is one of these.
const LEGACY_MOV_ATOMS = ["moov", "mdat", "wide", "free", "skip", "pnot"];

const hasBrand =
	(brands: Set<string>): Signature =>
	(head) =>
		ftypBrands(head)?.some((brand) => brands.has(brand)) ?? false;

/** MP4, MOV, M4A, M4V, 3GP: any ISO-BMFF file whose major brand isn't a still image's. */
const isIsoMedia: Signature = (head) => {
	const brands = ftypBrands(head);
	if (!brands) return LEGACY_MOV_ATOMS.some((atom) => hasBytesAt(head, 4, ascii(atom)));
	const majorBrand = brands[0] ?? "";
	return !AVIF_BRANDS.has(majorBrand) && !HEIF_BRANDS.has(majorBrand);
};

// EBML (WebM, Matroska): the DocType string sits in the header, well inside the head.
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
const ebmlDocType =
	(...docTypes: string[]): Signature =>
	(head) => {
		if (!hasBytesAt(head, 0, EBML_MAGIC)) return false;
		const header = readAscii(head, 4, 64);
		return docTypes.some((docType) => header.includes(docType));
	};

const isPng = startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const isJpeg = startsWith(0xff, 0xd8, 0xff);
const isGif: Signature = (head) => hasBytesAt(head, 0, ascii("GIF87a")) || hasBytesAt(head, 0, ascii("GIF89a"));
const isWebp = riff("WEBP");
const isWav = riff("WAVE");
const isAvif = hasBrand(AVIF_BRANDS);
const isHeif = hasBrand(HEIF_BRANDS);
const isWebm = ebmlDocType("webm");
const isMatroskaOrWebm = ebmlDocType("matroska", "webm");
const isOgg = startsWith(...ascii("OggS"), 0x00);
const isFlac = startsWith(...ascii("fLaC"));
// ID3 tag, or an MPEG audio frame sync (11 set bits).
const isMp3: Signature = (head) =>
	hasBytesAt(head, 0, ascii("ID3")) || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0);
// PK\x03\x04 (a file entry) or PK\x05\x06 (an empty archive): DOCX, XLSX and PPTX are zip files.
const isZip: Signature = (head) =>
	hasBytesAt(head, 0, [0x50, 0x4b, 0x03, 0x04]) || hasBytesAt(head, 0, [0x50, 0x4b, 0x05, 0x06]);

function utf16Encoding(head: Uint8Array): "utf-16le" | "utf-16be" | null {
	if (hasBytesAt(head, 0, [0xff, 0xfe])) return "utf-16le";
	if (hasBytesAt(head, 0, [0xfe, 0xff])) return "utf-16be";
	return null;
}

// WHATWG "binary data bytes": control characters no text file contains.
function isBinaryDataByte(byte: number): boolean {
	return byte <= 0x08 || byte === 0x0b || (byte >= 0x0e && byte <= 0x1a) || (byte >= 0x1c && byte <= 0x1f);
}

function decodesStrictly(head: Uint8Array, encoding: string): boolean {
	try {
		// `stream: true`: a multibyte sequence cut at the end of the head isn't an error.
		new TextDecoder(encoding, { fatal: true }).decode(head, { stream: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * Text a person could have written: no binary control bytes (UTF-8, or a legacy 8-bit encoding such as a Windows-1252
 * CSV export), or UTF-16 with its BOM.
 */
const isText: Signature = (head) => {
	const utf16 = utf16Encoding(head);
	if (utf16) return decodesStrictly(head.subarray(2), utf16);
	return !head.some(isBinaryDataByte);
};

function leadingText(head: Uint8Array): string {
	const decoded = new TextDecoder(utf16Encoding(head) ?? "utf-8").decode(head.subarray(0, 1024), { stream: true });
	return decoded.replace(/^﻿/, "").trimStart();
}

// JSON is UTF-8 (RFC 8259): text that decodes strictly and opens an object or an array.
const isJson: Signature = (head) =>
	!head.some(isBinaryDataByte) && decodesStrictly(head, "utf-8") && /^[{[]/.test(leadingText(head));

const SCRIPTABLE_PREFIXES: Array<[prefix: string, family: string]> = [
	["<!doctype html", "html"],
	["<html", "html"],
	["<head", "html"],
	["<body", "html"],
	["<script", "html"],
	["<iframe", "html"],
	["<svg", "svg"],
	["<?xml", "xml"],
];

/** `html`, `svg` or `xml` when the head is a document a browser would render and run, otherwise null. */
export function detectScriptable(head: Uint8Array): string | null {
	const start = leadingText(head).slice(0, 512).toLowerCase();
	const found = SCRIPTABLE_PREFIXES.find(([prefix]) => start.startsWith(prefix));
	if (!found) return null;
	if (found[1] === "xml" && start.includes("<svg")) return "svg";
	return found[1];
}

// Only names what a mismatching upload looks like, for the error body: the first signature that fits wins.
const FAMILIES: Array<[family: string, signature: Signature]> = [
	["pdf", startsWith(...PDF_HEADER)],
	["png", isPng],
	["jpeg", isJpeg],
	["gif", isGif],
	["webp", isWebp],
	["wav", isWav],
	["avif", isAvif],
	["heif", isHeif],
	["mp4", isIsoMedia],
	["webm", isWebm],
	["matroska", isMatroskaOrWebm],
	["ogg", isOgg],
	["flac", isFlac],
	["zip", isZip],
	["mp3", isMp3],
	["json", isJson],
	["text", isText],
	["pdf", isPdf],
];

/** What the head looks like: a scriptable type, a known family, `empty` or `binary`. */
export function detectFamily(head: Uint8Array): string {
	if (head.length === 0) return "empty";
	const scriptable = detectScriptable(head);
	if (scriptable) return scriptable;
	return FAMILIES.find(([, signature]) => signature(head))?.[0] ?? "binary";
}

const OFFICE_ZIP_TYPES = ["wordprocessingml.document", "spreadsheetml.sheet", "presentationml.presentation"].map(
	(subtype) => `application/vnd.openxmlformats-officedocument.${subtype}`,
);

const typesWith = (types: string[], signature: Signature): Array<[string, Signature]> =>
	types.map((type) => [type, signature]);

// Declared type (its essence) → the signature its bytes must have.
const SIGNATURES = new Map<string, Signature>([
	["application/pdf", isPdf],
	["image/png", isPng],
	["image/jpeg", isJpeg],
	["image/gif", isGif],
	["image/webp", isWebp],
	["image/avif", isAvif],
	...typesWith(["image/heic", "image/heif"], isHeif),
	...typesWith(["video/mp4", "video/quicktime", "video/x-m4v", "video/3gpp", "audio/mp4", "audio/x-m4a"], isIsoMedia),
	...typesWith(["video/webm", "audio/webm"], isWebm),
	...typesWith(["video/x-matroska", "audio/x-matroska"], isMatroskaOrWebm),
	...typesWith(["audio/mpeg", "audio/mp3"], isMp3),
	...typesWith(["audio/ogg", "video/ogg", "application/ogg", "audio/opus"], isOgg),
	...typesWith(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"], isWav),
	...typesWith(["audio/flac", "audio/x-flac"], isFlac),
	...typesWith(["application/zip", "application/x-zip-compressed", ...OFFICE_ZIP_TYPES], isZip),
	...typesWith(["text/plain", "text/csv", "text/markdown", "text/tab-separated-values"], isText),
	["application/json", isJson],
]);

function essenceOf(contentType: string): string {
	return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Does `head` (the first bytes of the plaintext, ≤4 KB are read) match `declaredType`? */
export function sniffContent(declaredType: string, head: Uint8Array): SniffResult {
	const signature = SIGNATURES.get(essenceOf(declaredType));
	if (!signature) return { verdict: "unverifiable" };
	const sample = head.subarray(0, SNIFF_HEAD_BYTES);
	const scriptable = detectScriptable(sample);
	if (scriptable) return { verdict: "mismatch", detected: scriptable };
	if (signature(sample)) return { verdict: "match" };
	return { verdict: "mismatch", detected: detectFamily(sample) };
}
