import { describe, expect, it } from "vitest";
import { matchesAccept, mediaTypeOfAccept, uploadAcceptOf } from "./media-picker-accept";

const file = (name: string, type: string) => ({ name, type });

describe("matchesAccept", () => {
	it("matches MIME types, wildcards and extensions, case-insensitively", () => {
		expect(matchesAccept(file("a.PNG", "image/png"), ["image/*"])).toBe(true);
		expect(matchesAccept(file("a.pdf", "application/pdf"), ["application/pdf"])).toBe(true);
		expect(matchesAccept(file("Report.PDF", ""), [".pdf"])).toBe(true);
		expect(matchesAccept(file("a.mp4", "video/mp4"), ["image/*", ".pdf"])).toBe(false);
	});

	it("accepts everything without patterns", () => {
		expect(matchesAccept(file("a.bin", ""), undefined)).toBe(true);
		expect(matchesAccept(file("a.bin", ""), [])).toBe(true);
	});
});

describe("mediaTypeOfAccept and uploadAcceptOf", () => {
	it("gives the library one type only when every pattern has it", () => {
		expect(mediaTypeOfAccept(["image/png", "image/*"])).toBe("image");
		expect(mediaTypeOfAccept(["application/pdf", ".docx"])).toBe("file");
		expect(mediaTypeOfAccept(["image/*", "video/*"])).toBeUndefined();
		expect(mediaTypeOfAccept(undefined)).toBeUndefined();
	});

	it("prefers the picker's accept, then its type's", () => {
		expect(uploadAcceptOf([".pdf"], "image")).toEqual([".pdf"]);
		expect(uploadAcceptOf(undefined, "video")).toEqual(["video/*"]);
		expect(uploadAcceptOf(undefined, "file")).toBeUndefined();
	});
});
