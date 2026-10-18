import { describe, expect, it } from "vitest";
import { areLocalesAllowed, isContentTypeAllowed } from "./helpers";

describe("isContentTypeAllowed", () => {
	it("allows everything when the accept list is empty or undefined", () => {
		expect(isContentTypeAllowed("image/png", undefined)).toBe(true);
		expect(isContentTypeAllowed("image/png", [])).toBe(true);
	});

	it("matches an exact content type", () => {
		expect(isContentTypeAllowed("image/png", ["image/png", "image/jpeg"])).toBe(true);
		expect(isContentTypeAllowed("image/gif", ["image/png", "image/jpeg"])).toBe(false);
	});

	it("matches a family wildcard", () => {
		expect(isContentTypeAllowed("image/webp", ["image/*"])).toBe(true);
		expect(isContentTypeAllowed("video/mp4", ["image/*"])).toBe(false);
	});

	it("treats `*` and `*/*` as allow-all", () => {
		expect(isContentTypeAllowed("anything/here", ["*"])).toBe(true);
		expect(isContentTypeAllowed("video/mp4", ["*/*"])).toBe(true);
	});

	it("ignores parameters and case, and trims", () => {
		expect(isContentTypeAllowed("IMAGE/PNG; charset=binary", ["image/png"])).toBe(true);
		expect(isContentTypeAllowed("image/png", [" image/png "])).toBe(true);
	});
});

describe("areLocalesAllowed", () => {
	it("allows everything when the whitelist is empty or undefined", () => {
		expect(areLocalesAllowed(["es", "fr"], undefined)).toBe(true);
		expect(areLocalesAllowed(["es", "fr"], [])).toBe(true);
	});

	it("requires every requested locale to be in the whitelist", () => {
		expect(areLocalesAllowed(["es"], ["es", "fr"])).toBe(true);
		expect(areLocalesAllowed(["es", "fr"], ["es", "fr"])).toBe(true);
		expect(areLocalesAllowed(["es", "de"], ["es", "fr"])).toBe(false);
	});

	it("is case-insensitive", () => {
		expect(areLocalesAllowed(["ES"], ["es"])).toBe(true);
	});
});
