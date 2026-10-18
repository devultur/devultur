import { describe, expect, it } from "vitest";
import { getDownloadUrl } from "./download";

const url = "https://media.example.com/v1/media/image/abc/foto.jpg";

describe("getDownloadUrl", () => {
	it("appends the download flag to a bare URL", () => {
		expect(getDownloadUrl(url)).toBe(`${url}?download`);
	});

	it("uses & when the URL already has a query string", () => {
		expect(getDownloadUrl(`${url}?w=200`)).toBe(`${url}?w=200&download`);
	});

	it("passes a custom filename, url-encoded", () => {
		expect(getDownloadUrl(url, { filename: "mi foto.jpg" })).toBe(`${url}?download=mi%20foto.jpg`);
	});

	it("keeps the download param readable by URLSearchParams", () => {
		const params = new URL(getDownloadUrl(url)).searchParams;
		// present even with no value → the worker detects it with `.get(...) !== null`
		expect(params.get("download")).toBe("");
		expect(new URL(getDownloadUrl(url, { filename: "x.png" })).searchParams.get("download")).toBe("x.png");
	});
});
