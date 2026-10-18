import { describe, expect, it } from "vitest";
import { sanitizeFilename } from "./filenames";
import { type DevulturMedia, mediaPath, mediaThumbnailPath, mediaUrl, publicUrl, resolveVisibility } from "./media";

const BASE = "https://acme.example.com";

const publicImage: DevulturMedia<"public"> = {
	id: "abc123",
	kind: "image",
	visibility: "public",
	filename: "foto.jpg",
	width: 1024,
	height: 768,
};

const privateImage: DevulturMedia<"private"> = {
	id: "def456",
	kind: "image",
	visibility: "private",
	filename: "material.png",
};

describe("resolveVisibility", () => {
	it("prioritizes the upload override over the router default", () => {
		expect(resolveVisibility("public", "private")).toBe("public");
	});

	it("falls back to the router default when the upload doesn't specify", () => {
		expect(resolveVisibility(undefined, "public")).toBe("public");
	});

	it("is private if not specified anywhere (secure-by-default)", () => {
		expect(resolveVisibility(undefined, undefined)).toBe("private");
	});
});

describe("mediaPath", () => {
	it("image: {visibility}/image/{id}/{filename}", () => {
		expect(mediaPath(publicImage)).toBe("public/image/abc123/foto.jpg");
	});

	it("file: {visibility}/file/{id}/{filename}", () => {
		const file: DevulturMedia = { id: "f1", kind: "file", visibility: "private", filename: "guia.pdf" };
		expect(mediaPath(file)).toBe("private/file/f1/guia.pdf");
	});

	it("video: {visibility}/video/{id}/hls/playlist.m3u8 (the playable one)", () => {
		const video: DevulturMedia = { id: "v1", kind: "video", visibility: "public" };
		expect(mediaPath(video)).toBe("public/video/v1/hls/playlist.m3u8");
	});

	it("falls back to the id as the name when there's no filename", () => {
		const img: DevulturMedia = { id: "noname", kind: "image", visibility: "public" };
		expect(mediaPath(img)).toBe("public/image/noname/noname");
	});
});

// Regression: upload stores the key with `sanitizeFilename`; delivery MUST derive the
// same sanitized path or it 404s. `mediaPath` is the single source of truth for delivery URLs → sanitized here.
describe("mediaPath — sanitizes the filename to mirror the upload key (round-trip)", () => {
	// Mirrors `upload.ts`: key = `{vis}/{kind}/{id}/{sanitizeFilename(filename)}`.
	const uploadKey = (visibility: string, kind: "image" | "file", id: string, filename: string) =>
		`${visibility}/${kind}/${id}/${sanitizeFilename(filename)}`;

	const CASES: Array<{ label: string; filename: string; expected: string }> = [
		{ label: "space", filename: "resumen ejecutivo.pdf", expected: "resumen-ejecutivo.pdf" },
		{ label: "accent", filename: "Cédula ciudadanía.pdf", expected: "Cedula-ciudadania.pdf" },
		{ label: "ñ", filename: "Diseño final.png", expected: "Diseno-final.png" },
		{ label: "parentheses", filename: "Contrato (2024).pdf", expected: "Contrato-2024.pdf" },
		{ label: "double space + #", filename: "Nómina  #12.pdf", expected: "Nomina-12.pdf" },
	];

	for (const { label, filename, expected } of CASES) {
		it(`file with ${label}: delivery-path === upload-key`, () => {
			const file: DevulturMedia = { id: "f1", kind: "file", visibility: "private", filename };
			expect(mediaPath(file)).toBe(`private/file/f1/${expected}`);
			expect(mediaPath(file)).toBe(uploadKey("private", "file", "f1", filename));
		});

		it(`image with ${label}: delivery-path === upload-key`, () => {
			const img: DevulturMedia = { id: "i1", kind: "image", visibility: "public", filename };
			expect(mediaPath(img)).toBe(`public/image/i1/${expected}`);
			expect(mediaPath(img)).toBe(uploadKey("public", "image", "i1", filename));
		});
	}

	it("filename already URL-safe → no-op (non-breaking for existing media)", () => {
		const file: DevulturMedia = { id: "f2", kind: "file", visibility: "private", filename: "guia_v2.pdf" };
		expect(mediaPath(file)).toBe("private/file/f2/guia_v2.pdf");
	});

	it("video: the filename does NOT enter the path (hls/playlist.m3u8) → no change", () => {
		const video: DevulturMedia = { id: "v1", kind: "video", visibility: "private", filename: "Mi Vídeo #1.mp4" };
		expect(mediaPath(video)).toBe("private/video/v1/hls/playlist.m3u8");
	});
});

describe("mediaThumbnailPath", () => {
	it("gives the thumbnail for video with the same visibility prefix", () => {
		const video: DevulturMedia = { id: "v1", kind: "video", visibility: "private" };
		expect(mediaThumbnailPath(video)).toBe("private/video/v1/thumbnails/thumbnail.jpg");
	});

	it("is null for image/file", () => {
		expect(mediaThumbnailPath(publicImage)).toBeNull();
	});
});

describe("mediaUrl — token-transparent", () => {
	it("public: does NOT attach the token even if passed (cacheable/crawler-safe URL)", () => {
		expect(mediaUrl(BASE, publicImage, { token: "jwt" })).toBe(`${BASE}/v1/media/public/image/abc123/foto.jpg`);
	});

	it("private: injects the token", () => {
		expect(mediaUrl(BASE, privateImage, { token: "jwt" })).toBe(
			`${BASE}/v1/media/private/image/def456/material.png?token=jwt`,
		);
	});

	it("composes transforms on top of the reference", () => {
		expect(mediaUrl(BASE, publicImage, { width: 512, format: "webp" })).toBe(
			`${BASE}/v1/media/public/image/abc123/foto.jpg?w=512&format=webp`,
		);
	});

	it("private with transforms + token", () => {
		expect(mediaUrl(BASE, privateImage, { token: "jwt", width: 256 })).toBe(
			`${BASE}/v1/media/private/image/def456/material.png?token=jwt&w=256`,
		);
	});
});

describe("publicUrl", () => {
	it("gives a stable URL with no token", () => {
		expect(publicUrl(BASE, publicImage)).toBe(`${BASE}/v1/media/public/image/abc123/foto.jpg`);
	});

	it("accepts transforms but never a token", () => {
		expect(publicUrl(BASE, publicImage, { width: 1200, format: "avif" })).toBe(
			`${BASE}/v1/media/public/image/abc123/foto.jpg?w=1200&format=avif`,
		);
	});
});
