import type { DevulturMedia } from "@devultur/core";
import { describe, expect, it } from "vitest";
import { expectedContentType, previewKindOf, trustedContentType } from "./preview-type";

const file = (filename?: string): DevulturMedia => ({ id: "f1", kind: "file", visibility: "private", filename });

describe("previewKindOf", () => {
	it("maps allowlisted types, ignoring case and parameters", () => {
		expect(previewKindOf("Application/PDF; charset=binary")).toBe("pdf");
		expect(previewKindOf("image/avif")).toBe("image");
		expect(previewKindOf("text/csv")).toBe("text");
	});

	it.each([
		"text/html",
		"image/svg+xml",
		"application/xml",
		"application/xhtml+xml",
		"text/xml",
		"constructor",
		"",
	])("refuses %s", (contentType) => expect(previewKindOf(contentType)).toBeNull());
});

describe("expectedContentType", () => {
	it("prefers the declared type and infers from the extension otherwise", () => {
		expect(expectedContentType(file("scan.PDF"))).toBe("application/pdf");
		expect(expectedContentType(file("scan.pdf"), "image/png")).toBe("image/png");
	});

	it("knows nothing about a name without an extension", () => {
		expect(expectedContentType(file("pdf"))).toBeNull();
		expect(expectedContentType(file())).toBeNull();
	});
});

describe("trustedContentType", () => {
	it("forces the expected type when the response agrees", () => {
		expect(trustedContentType("image/png", "image/webp")).toEqual({ ok: true, contentType: "image/png" });
	});

	it("refuses a response that renders differently, and an expected type that isn't allowlisted", () => {
		expect(trustedContentType("application/pdf", "text/html")).toEqual({ ok: false, reason: "type_mismatch" });
		expect(trustedContentType("image/png", "image/svg+xml")).toEqual({ ok: false, reason: "type_mismatch" });
		expect(trustedContentType("text/html", "text/html")).toEqual({ ok: false, reason: "unsupported_type" });
	});

	it("without an expected type, keeps only an allowlisted response type", () => {
		expect(trustedContentType(undefined, "audio/ogg")).toEqual({ ok: true, contentType: "audio/ogg" });
		expect(trustedContentType(undefined, "text/html")).toEqual({ ok: true, contentType: "application/octet-stream" });
	});
});
