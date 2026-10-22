import { describe, expect, it } from "vitest";
import { detectFamily, detectScriptable, sniffContent } from "./content-sniff";

const encoder = new TextEncoder();

function bytes(...chunks: Array<string | number[]>): Uint8Array {
	const parts = chunks.map((chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : new Uint8Array(chunk)));
	const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
}

// `ftyp` box: size, "ftyp", major brand, minor version, compatible brands.
function ftyp(majorBrand: string, ...compatibleBrands: string[]): Uint8Array {
	const size = 16 + compatibleBrands.length * 4;
	return bytes([0, 0, 0, size], "ftyp", majorBrand, [0, 0, 0, 0], compatibleBrands.join(""), [0, 0, 0, 8], "free");
}

const ebml = (docType: string) =>
	bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84], docType);

const SAMPLES = {
	pdf: bytes("%PDF-1.7\n%", [0xe2, 0xe3, 0xcf, 0xd3]),
	png: bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], "IHDR"),
	jpeg: bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16], "JFIF"),
	gif: bytes("GIF89a", [1, 0, 1, 0]),
	webp: bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 "),
	avif: ftyp("avif", "avif", "mif1", "miaf"),
	heic: ftyp("heic", "mif1", "heic"),
	mp4: ftyp("isom", "isom", "iso2", "mp41"),
	mov: ftyp("qt  ", "qt  "),
	legacyMov: bytes([0, 0, 0, 8], "wide", [0, 0, 0, 8], "mdat"),
	m4a: ftyp("M4A ", "M4A ", "isom"),
	webm: ebml("webm"),
	mkv: ebml("matroska"),
	mp3Id3: bytes("ID3", [4, 0, 0, 0, 0, 0, 0]),
	mp3Frame: bytes([0xff, 0xfb, 0x90, 0x64]),
	ogg: bytes("OggS", [0, 2, 0, 0]),
	wav: bytes("RIFF", [0x24, 0, 0, 0], "WAVEfmt "),
	flac: bytes("fLaC", [0, 0, 0, 34]),
	zip: bytes([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0], "[Content_Types].xml"),
	text: bytes("Hello, world.\nSecond line\twith a tab.\r\n"),
	csv: bytes("name,city\nJosé,Bogotá\n"),
	json: bytes('  {"name": "clip"}'),
};

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("sniffContent: each family matches its declared type", () => {
	it.each([
		["application/pdf", SAMPLES.pdf],
		["image/png", SAMPLES.png],
		["image/jpeg", SAMPLES.jpeg],
		["image/gif", SAMPLES.gif],
		["image/webp", SAMPLES.webp],
		["image/avif", SAMPLES.avif],
		["image/heic", SAMPLES.heic],
		["image/heif", SAMPLES.heic],
		["video/mp4", SAMPLES.mp4],
		["video/quicktime", SAMPLES.mov],
		["video/quicktime", SAMPLES.legacyMov],
		["video/mp4", SAMPLES.mov],
		["audio/mp4", SAMPLES.m4a],
		["audio/x-m4a", SAMPLES.m4a],
		["video/x-m4v", SAMPLES.mp4],
		["video/webm", SAMPLES.webm],
		["audio/webm", SAMPLES.webm],
		["video/x-matroska", SAMPLES.mkv],
		["video/x-matroska", SAMPLES.webm],
		["audio/mpeg", SAMPLES.mp3Id3],
		["audio/mpeg", SAMPLES.mp3Frame],
		["audio/ogg", SAMPLES.ogg],
		["video/ogg", SAMPLES.ogg],
		["audio/wav", SAMPLES.wav],
		["audio/x-wav", SAMPLES.wav],
		["audio/flac", SAMPLES.flac],
		["application/zip", SAMPLES.zip],
		[DOCX, SAMPLES.zip],
		[XLSX, SAMPLES.zip],
		[PPTX, SAMPLES.zip],
		["text/plain", SAMPLES.text],
		["text/csv", SAMPLES.csv],
		["application/json", SAMPLES.json],
		["application/json", bytes("[1, 2, 3]")],
	])("%s", (declared, head) => {
		expect(sniffContent(declared, head)).toEqual({ verdict: "match" });
	});

	it("ignores parameters and case in the declared type", () => {
		expect(sniffContent("Text/Plain; charset=utf-8", SAMPLES.text)).toEqual({ verdict: "match" });
		expect(sniffContent("IMAGE/PNG", SAMPLES.png)).toEqual({ verdict: "match" });
	});

	it("finds a PDF header anywhere in the first 1024 bytes, not past them", () => {
		const junk = new Array(1000).fill(0x00);
		expect(sniffContent("application/pdf", bytes(junk, "%PDF-1.4"))).toEqual({ verdict: "match" });
		expect(sniffContent("application/pdf", bytes(new Array(1100).fill(0x00), "%PDF-1.4")).verdict).toBe("mismatch");
	});
});

describe("sniffContent: mismatches", () => {
	it.each([
		["image/png", SAMPLES.jpeg, "jpeg"],
		["image/jpeg", SAMPLES.png, "png"],
		["video/mp4", SAMPLES.webm, "webm"],
		["video/webm", SAMPLES.mkv, "matroska"],
		["image/avif", SAMPLES.heic, "heif"],
		["video/mp4", SAMPLES.avif, "avif"],
		["application/pdf", SAMPLES.zip, "zip"],
		["audio/wav", SAMPLES.webp, "webp"],
		["application/json", SAMPLES.text, "text"],
		["text/plain", SAMPLES.png, "png"],
		["image/png", new Uint8Array(), "empty"],
		["video/mp4", new Uint8Array(64), "binary"],
	])("%s that is %s", (declared, head, detected) => {
		expect(sniffContent(declared, head)).toEqual({ verdict: "mismatch", detected });
	});
});

describe("sniffContent: scriptable content disguised as an inert type", () => {
	const disguises: Array<[string, string]> = [
		["<!DOCTYPE html><html><script>alert(1)</script>", "html"],
		["<html><body>hi</body></html>", "html"],
		["<script>alert(1)</script>", "html"],
		['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', "svg"],
		['<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>', "svg"],
		['<?xml version="1.0"?><feed/>', "xml"],
		["\n\t  <HTML>", "html"],
	];

	it.each(
		["application/pdf", "image/png", "image/jpeg", "text/plain", "text/csv", "application/json", "video/mp4"].flatMap(
			(declared) => disguises.map(([content, detected]) => [declared, content, detected] as const),
		),
	)("%s declaring %s", (declared, content, detected) => {
		expect(sniffContent(declared, bytes(content))).toEqual({ verdict: "mismatch", detected });
	});

	it("sees through a UTF-8 BOM and leading whitespace", () => {
		const head = bytes([0xef, 0xbb, 0xbf], "  \r\n<script>alert(1)</script>");
		expect(sniffContent("text/plain", head)).toEqual({ verdict: "mismatch", detected: "html" });
	});

	it("sees through UTF-16 with its BOM", () => {
		const utf16le = [0xff, 0xfe, ...Array.from("<svg/>").flatMap((char) => [char.charCodeAt(0), 0])];
		expect(sniffContent("text/plain", bytes(utf16le))).toEqual({ verdict: "mismatch", detected: "svg" });
	});

	it("catches HTML in front of a PDF header (a polyglot)", () => {
		expect(sniffContent("application/pdf", bytes("<html><script>x</script>%PDF-1.7"))).toEqual({
			verdict: "mismatch",
			detected: "html",
		});
	});

	it("doesn't flag text that only mentions a tag", () => {
		expect(detectScriptable(bytes("Use the <svg> element"))).toBeNull();
	});
});

describe("sniffContent: text heuristics", () => {
	it("accepts UTF-8 with a BOM and a legacy 8-bit export", () => {
		expect(sniffContent("text/csv", bytes([0xef, 0xbb, 0xbf], "a,b\n1,2\n"))).toEqual({ verdict: "match" });
		// "José" in Windows-1252: not UTF-8, still text.
		expect(sniffContent("text/csv", bytes("name\nJos", [0xe9], "\n"))).toEqual({ verdict: "match" });
	});

	it("accepts UTF-16 with its BOM", () => {
		const utf16le = [0xff, 0xfe, ...Array.from("hola").flatMap((char) => [char.charCodeAt(0), 0])];
		expect(sniffContent("text/plain", bytes(utf16le))).toEqual({ verdict: "match" });
	});

	it("rejects NUL and other binary control bytes", () => {
		expect(sniffContent("text/plain", bytes("abc", [0x00], "def")).verdict).toBe("mismatch");
		expect(sniffContent("text/plain", bytes("abc", [0x01], "def")).verdict).toBe("mismatch");
	});

	it("accepts a multibyte character cut at the end of the head", () => {
		const cut = bytes('{"city": "Bogot', [0xc3]);
		expect(sniffContent("application/json", cut)).toEqual({ verdict: "match" });
	});

	it("requires JSON to be UTF-8 and open an object or an array", () => {
		expect(sniffContent("application/json", bytes([0xef, 0xbb, 0xbf], "\n {}"))).toEqual({ verdict: "match" });
		expect(sniffContent("application/json", bytes('"just a string"')).verdict).toBe("mismatch");
		expect(sniffContent("application/json", bytes('{"name": "Jos', [0xe9], '"}')).verdict).toBe("mismatch");
	});

	it("accepts an empty text file", () => {
		expect(sniffContent("text/plain", new Uint8Array())).toEqual({ verdict: "match" });
	});
});

describe("sniffContent: types outside the table", () => {
	it.each([
		"text/html",
		"image/svg+xml",
		"application/xml",
		"application/octet-stream",
		"video/mp2t",
		"application/x-custom",
	])("%s is unverifiable", (declared) => {
		expect(sniffContent(declared, bytes("<html>"))).toEqual({ verdict: "unverifiable" });
	});
});

describe("detectFamily", () => {
	it("names what an upload looks like", () => {
		expect(detectFamily(SAMPLES.pdf)).toBe("pdf");
		expect(detectFamily(SAMPLES.mov)).toBe("mp4");
		expect(detectFamily(SAMPLES.ogg)).toBe("ogg");
		expect(detectFamily(SAMPLES.flac)).toBe("flac");
		expect(detectFamily(SAMPLES.mp3Id3)).toBe("mp3");
		expect(detectFamily(SAMPLES.json)).toBe("json");
	});
});
