import { describe, expect, it } from "vitest";
import {
	captionPath,
	extractId,
	filePath,
	generateId,
	imagePath,
	isVideoRawKey,
	videoBasePath,
	videoHlsPath,
	videoHlsPlaylistPath,
	videoRawPath,
	videoThumbnailPath,
} from "./paths";

describe("extractId", () => {
	const id = "db5066fd-85c7-42c5-93c3-678cc9d99b6f";

	it("extracts id from video raw path", () => {
		expect(extractId(videoRawPath(id, "clip.mp4"))).toBe(id);
	});

	it("extracts id from video hls path", () => {
		expect(extractId(videoHlsPath(id))).toBe(id);
	});

	it("extracts id from video playlist path", () => {
		expect(extractId(videoHlsPlaylistPath(id))).toBe(id);
	});

	it("extracts id from video thumbnail path", () => {
		expect(extractId(videoThumbnailPath(id))).toBe(id);
	});

	it("extracts id from image path", () => {
		expect(extractId(imagePath(id, "photo.jpg"))).toBe(id);
	});

	it("extracts id from file path", () => {
		expect(extractId(filePath(id, "doc.pdf"))).toBe(id);
	});

	it("extracts id from caption path", () => {
		expect(extractId(captionPath(id, "es"))).toBe(id);
	});

	it("returns the string itself when no slashes", () => {
		expect(extractId(id)).toBe(id);
	});

	// Regression: upload/delivery keys carry a visibility prefix `{visibility}/{kind}/{id}/…`.
	// Without the offset, extractId returned the kind ("video") instead of the id → mis-keyed record → stuck UI.
	it("extracts id from visibility-prefixed keys (private/video/{id}/raw/...)", () => {
		expect(extractId(`private/video/${id}/raw/clip.mp4`)).toBe(id);
		expect(extractId(`public/image/${id}/photo.png`)).toBe(id);
		expect(extractId(`private/file/${id}/doc.pdf`)).toBe(id);
		expect(extractId(`private/video/${id}/hls/playlist.m3u8`)).toBe(id);
	});

	it("consistent across all path builders", () => {
		const paths = [
			videoRawPath(id, "video.mp4"),
			videoHlsPath(id),
			videoHlsPlaylistPath(id),
			videoThumbnailPath(id),
			imagePath(id, "img.png"),
			filePath(id, "file.zip"),
			captionPath(id, "en"),
		];

		const extracted = paths.map(extractId);
		const allMatch = extracted.every((v) => v === id);
		expect(allMatch).toBe(true);
	});
});

// Regression guard: this bug (extractId returning the kind/another path segment instead of the id) has
// bitten us twice already. This block covers EVERY key shape the SDK produces and asserts two invariants:
// (1) it always returns exactly the id, and (2) it NEVER returns a structural segment (kind, visibility,
// raw/hls/thumbnails/captions, filename). If a refactor breaks extractId, it fails here.
describe("extractId — invariant: always the id, never another part of the path", () => {
	const id = generateId(); // real UUID, as in production
	const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

	// Every key shape that circulates through the system. `withVis` rewrites it with a visibility prefix,
	// which is the real upload/delivery format (`{visibility}/{kind}/{id}/…`).
	const withVis = (vis: string, key: string) => `${vis}/${key}`;
	const baseKeys = [
		videoRawPath(id, "clip.mp4"),
		videoHlsPath(id),
		videoHlsPlaylistPath(id),
		videoThumbnailPath(id),
		imagePath(id, "photo.png"),
		filePath(id, "doc.pdf"),
		captionPath(id, "es"),
		`video/${id}/hls/720p_007.ts`,
	];
	const allKeys = [
		...baseKeys, // no prefix (internal path helpers)
		...baseKeys.map((k) => withVis("private", k)),
		...baseKeys.map((k) => withVis("public", k)),
	];

	// Segments that must NEVER come out of extractId (anything that isn't the id).
	const FORBIDDEN = new Set(["public", "private", "video", "image", "file", "raw", "hls", "thumbnails", "captions"]);

	for (const key of allKeys) {
		it(`→ id (not a segment) for "${key}"`, () => {
			const result = extractId(key);
			expect(result).toBe(id);
			expect(result).toMatch(UUID_RE); // shaped like an id, not a path
			expect(FORBIDDEN.has(result)).toBe(false); // never the kind/visibility/subfolder
			expect(result).not.toContain("."); // never a filename
			expect(result).not.toContain("/"); // never multiple segments
		});
	}
});

describe("key builders", () => {
	const id = "db5066fd-85c7-42c5-93c3-678cc9d99b6f";

	it("builds the expected keys", () => {
		expect(videoRawPath(id, "clip.mp4")).toBe(`video/${id}/raw/clip.mp4`);
		expect(videoHlsPath(id)).toBe(`video/${id}/hls`);
		expect(videoHlsPlaylistPath(id)).toBe(`video/${id}/hls/playlist.m3u8`);
		expect(videoThumbnailPath(id)).toBe(`video/${id}/thumbnails/thumbnail.jpg`);
		expect(imagePath(id, "photo.jpg")).toBe(`image/${id}/photo.jpg`);
		expect(filePath(id, "doc.pdf")).toBe(`file/${id}/doc.pdf`);
		expect(captionPath(id, "es")).toBe(`video/${id}/captions/es.vtt`);
	});

	it("prefixes each media type correctly", () => {
		expect(videoRawPath(id, "a.mp4").startsWith("video/")).toBe(true);
		expect(imagePath(id, "a.jpg").startsWith("image/")).toBe(true);
		expect(filePath(id, "a.pdf").startsWith("file/")).toBe(true);
	});

	it("places the id as the second segment (matches extractId)", () => {
		expect(videoRawPath(id, "a.mp4").split("/")[1]).toBe(id);
		expect(imagePath(id, "a.jpg").split("/")[1]).toBe(id);
		expect(filePath(id, "a.pdf").split("/")[1]).toBe(id);
	});
});

describe("videoBasePath", () => {
	const id = "db5066fd-85c7-42c5-93c3-678cc9d99b6f";

	it("is the common prefix of every per-video object", () => {
		const base = videoBasePath(id);
		expect(base).toBe(`video/${id}`);
		// Video delete lists `${base}/` → must cover raw, hls, thumbnails and captions.
		for (const key of [
			videoRawPath(id, "clip.mp4"),
			videoHlsPath(id),
			videoHlsPlaylistPath(id),
			videoThumbnailPath(id),
			captionPath(id, "es"),
		]) {
			expect(key.startsWith(`${base}/`)).toBe(true);
		}
	});
});

describe("isVideoRawKey", () => {
	const id = "db5066fd-85c7-42c5-93c3-678cc9d99b6f";

	it("matches raw video keys, with or without a storagePrefix", () => {
		expect(isVideoRawKey(videoRawPath(id, "clip.mp4"))).toBe(true);
		expect(isVideoRawKey(`prefix-a/key_1/${videoRawPath(id, "clip.mp4")}`)).toBe(true);
	});

	it("does not match renditions, thumbnails, captions, or other media types", () => {
		expect(isVideoRawKey(videoHlsPlaylistPath(id))).toBe(false);
		expect(isVideoRawKey(videoThumbnailPath(id))).toBe(false);
		expect(isVideoRawKey(captionPath(id, "es"))).toBe(false);
		expect(isVideoRawKey(imagePath(id, "raw.png"))).toBe(false);
		expect(isVideoRawKey(filePath(id, "raw.zip"))).toBe(false);
	});
});

describe("generateId", () => {
	it("returns a v4 uuid", () => {
		expect(generateId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	});

	it("returns unique ids", () => {
		expect(generateId()).not.toBe(generateId());
	});
});
