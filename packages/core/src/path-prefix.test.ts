import { describe, expect, it } from "vitest";
import { isPrefixWithin, isWithinPathPrefix, normalizePathPrefix, relativeMediaPath } from "./path-prefix";

describe("normalizePathPrefix", () => {
	it("stores a relative folder with a trailing slash", () => {
		expect(normalizePathPrefix("image")).toBe("image/");
		expect(normalizePathPrefix("/video/abc/")).toBe("video/abc/");
	});

	it("rejects empty, dot-dot, encoded and visibility-led prefixes", () => {
		for (const raw of ["", "/", "image/../video", "./image", "image/%2e%2e", "private/image", "public", "a//b", 7]) {
			expect(normalizePathPrefix(raw)).toBeNull();
		}
	});
});

describe("relativeMediaPath", () => {
	it("strips the visibility segment", () => {
		expect(relativeMediaPath("private/image/abc/a.png")).toBe("image/abc/a.png");
		expect(relativeMediaPath("public/video/abc/")).toBe("video/abc/");
	});

	it("cannot place keys without a real visibility or with unsafe segments", () => {
		for (const key of ["image/abc/a.png", "secret/image/abc", "private/image/../video/x", "private/", "private/a//b"]) {
			expect(relativeMediaPath(key)).toBeNull();
		}
	});
});

describe("prefix containment", () => {
	it("matches by whole segments", () => {
		expect(isWithinPathPrefix("video/abc/raw/a.mp4", "video/abc/")).toBe(true);
		expect(isWithinPathPrefix("video/abcdef/raw/a.mp4", "video/abc/")).toBe(false);
		expect(isWithinPathPrefix("anything", undefined)).toBe(true);
	});

	it("a child prefix must stay inside the parent's", () => {
		expect(isPrefixWithin("image/a/", "image/")).toBe(true);
		expect(isPrefixWithin("video/", "image/")).toBe(false);
		expect(isPrefixWithin(undefined, "image/")).toBe(false);
		expect(isPrefixWithin(undefined, undefined)).toBe(true);
	});
});
