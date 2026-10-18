import { describe, expect, it } from "vitest";
import { buildMediaUrl } from "./media-url";

const base = "https://media.example.com";
const key = "image/abc/foto.jpg";
const url = `${base}/v1/media/${key}`;

describe("buildMediaUrl", () => {
	it("returns the bare URL with no options", () => {
		expect(buildMediaUrl(base, key)).toBe(url);
		expect(buildMediaUrl(base, key, {})).toBe(url);
	});

	it("appends a viewer token", () => {
		expect(buildMediaUrl(base, key, { token: "jwt.abc.def" })).toBe(`${url}?token=jwt.abc.def`);
	});

	it("forces download, keeping the original name", () => {
		expect(buildMediaUrl(base, key, { download: true })).toBe(`${url}?download`);
	});

	it("forces download with a custom filename", () => {
		expect(buildMediaUrl(base, key, { download: "avatar.webp" })).toBe(`${url}?download=avatar.webp`);
	});

	it("composes image transforms", () => {
		expect(buildMediaUrl(base, key, { width: 512, format: "webp", quality: 80 })).toBe(`${url}?w=512&format=webp&q=80`);
	});

	it("composes everything with download always last", () => {
		expect(buildMediaUrl(base, key, { token: "t", width: 512, format: "webp", download: "avatar.webp" })).toBe(
			`${url}?token=t&w=512&format=webp&download=avatar.webp`,
		);
	});

	it("keeps the download param readable and authorized by the worker", () => {
		const parsed = new URL(buildMediaUrl(base, key, { token: "t", download: true }));
		expect(parsed.searchParams.get("token")).toBe("t");
		expect(parsed.searchParams.get("download")).toBe(""); // presente → el worker lo detecta con `!== null`
	});
});
