// Text helpers and markup detection for content sniffing (content-sniff.ts). Markup is what a browser would render as
// a document and run: HTML (the WHATWG HTML-sniffing tags), SVG and XML. A tag only counts when a space, a line break
// or `>` follows its name, so prose that says "<b" or "a <bigger> b" isn't markup.

/** The window markup is looked for in (the PDF header's window too). */
export const MARKUP_WINDOW_BYTES = 1024;

export function utf16Encoding(head: Uint8Array): "utf-16le" | "utf-16be" | null {
	if (head[0] === 0xff && head[1] === 0xfe) return "utf-16le";
	if (head[0] === 0xfe && head[1] === 0xff) return "utf-16be";
	return null;
}

// WHATWG "binary data bytes": control characters no text file contains.
export function isBinaryDataByte(byte: number): boolean {
	return byte <= 0x08 || byte === 0x0b || (byte >= 0x0e && byte <= 0x1a) || (byte >= 0x1c && byte <= 0x1f);
}

export function decodesStrictly(head: Uint8Array, encoding: string): boolean {
	try {
		// `stream: true`: a multibyte sequence cut at the end of the head isn't an error.
		new TextDecoder(encoding, { fatal: true }).decode(head, { stream: true });
		return true;
	} catch {
		return false;
	}
}

/** The window as text (UTF-16 by its BOM, else UTF-8), without a BOM or leading whitespace. */
export function leadingText(head: Uint8Array): string {
	const window = head.subarray(0, MARKUP_WINDOW_BYTES);
	const decoded = new TextDecoder(utf16Encoding(head) ?? "utf-8").decode(window, { stream: true });
	return decoded.replace(/^﻿/, "").trimStart();
}

// The WHATWG HTML-sniffing tags.
const HTML_TAGS = ["html", "head", "script", "iframe", "h1", "div", "font", "table", "a", "style", "title", "b"];
const MORE_HTML_TAGS = ["body", "br", "p"];
// Long enough that compressed bytes or prose don't spell one (with its terminator) by chance: looked for anywhere.
const DISTINCT_TAGS = ["html", "head", "script", "iframe", "div", "font", "table", "style", "title", "body"];

const tagSource = (tags: string[]) => `<(?:${tags.join("|")})[\\s>]`;
const ANY_HTML_TAG = new RegExp(tagSource([...HTML_TAGS, ...MORE_HTML_TAGS]));
const DISTINCT_HTML_TAG = new RegExp(tagSource(DISTINCT_TAGS));
const SVG_TAG = /<svg[\s>/]/;
const LEADING_HTML = new RegExp(`^(?:<!doctype html|<!--|${tagSource([...HTML_TAGS, ...MORE_HTML_TAGS])})`);

/** `html`, `svg` or `xml` when the head starts (after a BOM and whitespace) as a document a browser would run. */
export function detectScriptable(head: Uint8Array): string | null {
	const start = leadingText(head).slice(0, 512).toLowerCase();
	if (start.startsWith("<?xml")) return SVG_TAG.test(start) ? "svg" : "xml";
	if (/^<svg[\s>/]/.test(start)) return "svg";
	if (LEADING_HTML.test(start)) return "html";
	return null;
}

function windowText(head: Uint8Array, end: number): string {
	const window = head.subarray(0, Math.min(end, MARKUP_WINDOW_BYTES));
	const utf16 = utf16Encoding(head);
	// Latin-1 keeps one character per byte, so a tag is found whatever encoding the rest of the bytes use.
	const text = utf16 ? new TextDecoder(utf16).decode(window, { stream: true }) : String.fromCharCode(...window);
	return text.toLowerCase();
}

function markupIn(text: string, htmlTag: RegExp): string | null {
	if (SVG_TAG.test(text)) return "svg";
	if (text.includes("<!doctype html") || htmlTag.test(text)) return "html";
	return null;
}

/** `html` or `svg` when a distinct tag shows up anywhere in the first 1024 bytes (`<svg`, `<script `, `<html>`, …). */
export function detectEmbeddedMarkup(head: Uint8Array): string | null {
	return markupIn(windowText(head, MARKUP_WINDOW_BYTES), DISTINCT_HTML_TAG);
}

/** `html` or `svg` when any HTML-sniffing tag (or `<!--`) comes before `end` (a PDF header's offset). */
export function detectMarkupBefore(head: Uint8Array, end: number): string | null {
	const text = windowText(head, end);
	if (text.includes("<!--")) return "html";
	return markupIn(text, ANY_HTML_TAG);
}
