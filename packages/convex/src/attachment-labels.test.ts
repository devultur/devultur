import type { DevulturMedia } from "@devultur/core";
import { describe, expect, it } from "vitest";
import {
	attachmentDetails,
	attachmentKindOf,
	attachmentName,
	defaultAttachmentLabels,
	formatDuration,
	formatFileSize,
	mergeAttachmentLabels,
} from "./attachment-labels";
import { attachmentLabels as spanishLabels } from "./locales/es";

const file = (filename: string, extra?: Partial<DevulturMedia>): DevulturMedia => ({
	id: "m1",
	kind: "file",
	visibility: "public",
	filename,
	...extra,
});

describe("formatFileSize", () => {
	it.each([
		[512, "en", "512 bytes"],
		[1_500, "en", "1.5 kB"],
		[12_345_678, "en", "12.3 MB"],
		[2_000_000_000, "en", "2 GB"],
		[512, "es", "512 bytes"],
		[1_500, "es", "1,5 kB"],
		[12_345_678, "es", "12,3 MB"],
	])("formats %i bytes in %s as %s", (bytes, locale, expected) => {
		expect(formatFileSize(bytes, locale)).toBe(expected);
	});
});

describe("formatDuration", () => {
	it.each([
		[42, "0:42"],
		[65, "1:05"],
		[3723, "1:02:03"],
		[59.6, "1:00"],
	])("formats %d seconds as %s", (seconds, expected) => {
		expect(formatDuration(seconds)).toBe(expected);
	});
});

describe("page counts", () => {
	it("says pages in English and Spanish", () => {
		expect(defaultAttachmentLabels.pages(1)).toBe("1 page");
		expect(defaultAttachmentLabels.pages(1200)).toBe("1,200 pages");
		expect(spanishLabels.pages(1)).toBe("1 página");
		expect(spanishLabels.pages(12)).toBe("12 páginas");
	});
});

describe("attachmentKindOf", () => {
	it.each([
		[file("report.pdf"), "pdf"],
		[file("song.mp3"), "audio"],
		[file("notes.txt"), "text"],
		[file("archive.zip"), "file"],
		[file("no-extension"), "file"],
		[{ ...file("cover.png"), kind: "image" as const }, "image"],
		[{ ...file("clip.mp4"), kind: "video" as const }, "video"],
	])("reads %o as %s", (media, expected) => {
		expect(attachmentKindOf(media)).toBe(expected);
	});

	it("trusts a declared content type over the extension", () => {
		expect(attachmentKindOf(file("download"), "application/pdf")).toBe("pdf");
	});
});

describe("attachmentName", () => {
	it("prefers the title, then the filename, then the untitled label", () => {
		expect(attachmentName(file("a.pdf", { title: "Annual report" }), "Untitled")).toBe("Annual report");
		expect(attachmentName(file("a.pdf", { title: "  " }), "Untitled")).toBe("a.pdf");
		expect(attachmentName({ id: "m1", kind: "file", visibility: "public" }, "Untitled")).toBe("Untitled");
	});
});

describe("attachmentDetails", () => {
	it("lists the type, size and page count of a PDF", () => {
		const media = file("a.pdf", { sizeBytes: 1_500_000, pageCount: 3, duration: 9 });
		expect(attachmentDetails(media, "pdf", defaultAttachmentLabels, "en")).toEqual(["PDF", "1.5 MB", "3 pages"]);
	});

	it("lists the duration of audio and video, never of other files", () => {
		const media = file("a.mp3", { duration: 65 });
		expect(attachmentDetails(media, "audio", spanishLabels, "es")).toEqual(["Audio", "1:05"]);
		expect(attachmentDetails(media, "file", spanishLabels, "es")).toEqual(["Archivo"]);
	});
});

describe("mergeAttachmentLabels", () => {
	it("keeps the defaults for missing or undefined keys", () => {
		const merged = mergeAttachmentLabels({ download: "Get it", open: undefined });
		expect(merged.download).toBe("Get it");
		expect(merged.open).toBe("Open preview");
	});
});
