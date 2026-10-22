// Content sniffing: do the first bytes of an upload match the Content-Type it declares? A hand-rolled signature table
// (no dependency, nothing parsed past a few fixed offsets) for the types the Worker serves inline. A type outside the
// table is `unverifiable`: it keeps its declared type, and delivery already sandboxes the risky ones.
// Scriptable content (HTML, SVG, XML; see markup-sniff.ts) is checked first, so a "PDF", "image" or "text" upload that
// is really a document a browser would run is always a mismatch, flagged `isScriptable`. The sniff never upgrades a
// type into a scriptable one.
import {
	decodesStrictly,
	detectEmbeddedMarkup,
	detectMarkupBefore,
	detectScriptable,
	isBinaryDataByte,
	leadingText,
	MARKUP_WINDOW_BYTES,
	utf16Encoding,
} from "./markup-sniff";

export { detectScriptable } from "./markup-sniff";

/** Bytes the sniff reads: enough for every signature below (the WHATWG sniffing header is 1445). */
export const SNIFF_HEAD_BYTES = 4096;

export type SniffResult =
	| { verdict: "match" }
	| { verdict: "mismatch"; detected: string; isScriptable: boolean }
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
// The PDF spec allows the header anywhere in the first 1024 bytes. -1 when it isn't there.
function pdfHeaderOffset(head: Uint8Array): number {
	const searchEnd = Math.min(head.length, MARKUP_WINDOW_BYTES) - PDF_HEADER.length;
	for (let offset = 0; offset <= searchEnd; offset++) {
		if (hasBytesAt(head, offset, PDF_HEADER)) return offset;
	}
	return -1;
}
const isPdf: Signature = (head) => pdfHeaderOffset(head) >= 0;

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

/**
 * Text a person could have written: no binary control bytes (UTF-8, or a legacy 8-bit encoding such as a Windows-1252
 * CSV export), or UTF-16 with its BOM.
 */
const isText: Signature = (head) => {
	const utf16 = utf16Encoding(head);
	if (utf16) return decodesStrictly(head.subarray(2), utf16);
	return !head.some(isBinaryDataByte);
};

// JSON is UTF-8 (RFC 8259): text that decodes strictly and opens an object or an array.
const isJson: Signature = (head) =>
	!head.some(isBinaryDataByte) && decodesStrictly(head, "utf-8") && /^[{[]/.test(leadingText(head));

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

const TEXT_TYPES = new Set([
	"text/plain",
	"text/csv",
	"text/markdown",
	"text/tab-separated-values",
	"application/json",
]);

// Markup past the start: before a PDF's header (any HTML-sniffing tag) or anywhere in the window of a PDF or text file
// (distinct tags only). Images and media start with their magic number, so the leading check covers them.
function embeddedMarkup(essence: string, head: Uint8Array): string | null {
	if (essence === "application/pdf") {
		const headerOffset = pdfHeaderOffset(head);
		const before = detectMarkupBefore(head, headerOffset < 0 ? MARKUP_WINDOW_BYTES : headerOffset);
		return before ?? detectEmbeddedMarkup(head);
	}
	return TEXT_TYPES.has(essence) ? detectEmbeddedMarkup(head) : null;
}

const SCRIPTABLE_FAMILIES = new Set(["html", "svg", "xml"]);

const mismatch = (detected: string): SniffResult => ({
	verdict: "mismatch",
	detected,
	isScriptable: SCRIPTABLE_FAMILIES.has(detected),
});

/** Does `head` (the first bytes of the plaintext, ≤4 KB are read) match `declaredType`? */
export function sniffContent(declaredType: string, head: Uint8Array): SniffResult {
	const essence = essenceOf(declaredType);
	const signature = SIGNATURES.get(essence);
	if (!signature) return { verdict: "unverifiable" };
	const sample = head.subarray(0, SNIFF_HEAD_BYTES);
	const scriptable = detectScriptable(sample) ?? embeddedMarkup(essence, sample);
	if (scriptable) return mismatch(scriptable);
	if (signature(sample)) return { verdict: "match" };
	return mismatch(detectFamily(sample));
}
