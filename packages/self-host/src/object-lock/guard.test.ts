import { describe, expect, it } from "vitest";
import { isReservedLockKey, lockSubjectOf } from "./guard";
import { encodeLockMetadata, isStateLocked, lockStateOf, parseLockMetadata } from "./state";

describe("lockSubjectOf", () => {
	it("maps a video's derived files and folder to its raws", () => {
		for (const key of [
			"private/video/v1/hls/playlist.m3u8",
			"private/video/v1/captions/en.vtt",
			"public/video/v1/mp4/main-720p.mp4",
			"private/video/v1",
		]) {
			expect(lockSubjectOf(key)).toEqual({
				kind: "video",
				rawPrefix: `${key.split("/").slice(0, 3).join("/")}/raw/`,
			});
		}
	});

	it("treats the raw, files, images and assets as originals", () => {
		for (const key of ["private/video/v1/raw/clip.mp4", "private/file/f1/doc.pdf", "public/asset/site/a.css"]) {
			expect(lockSubjectOf(key)).toEqual({ kind: "original", key });
		}
	});

	it("leaves image variants and mezzanines free (regenerable)", () => {
		expect(lockSubjectOf("public/image/i1/photo.jpg/__variants/w200.webp")).toBeNull();
		expect(lockSubjectOf("private/video/v1/thumbnails/poster.jpg/__variants/mezzanine.png")).toBeNull();
	});
});

describe("isReservedLockKey", () => {
	it.each(["__lock/a", "__lock-audit/2030/x.json", "/__lock/a", "__lock"])("reserves %s", (key) => {
		expect(isReservedLockKey(key)).toBe(true);
	});
	it.each(["private/__lock/a", "__locked/a", "public/asset/__lock-audit"])("allows %s", (key) => {
		expect(isReservedLockKey(key)).toBe(false);
	});
});

describe("lock metadata", () => {
	it("stores nothing for an unlocked file", () => {
		expect(encodeLockMetadata(undefined)).toBeUndefined();
		expect(encodeLockMetadata({ hold: false })).toBeUndefined();
		expect(encodeLockMetadata({ hold: true })).toBe('{"hold":true}');
	});

	it("fails closed on an unreadable value", () => {
		expect(parseLockMetadata("not json")).toEqual({ hold: true });
		expect(parseLockMetadata('{"retention":{"mode":"x"}}')).toEqual({ hold: true });
		expect(parseLockMetadata(undefined)).toBeUndefined();
	});

	it("counts a period from R2's uploaded, and fails closed without it", () => {
		const customMetadata = { lock: JSON.stringify({ retention: { mode: "compliance", period: 60 }, hold: false }) };
		const uploaded = new Date("2030-01-01T00:00:00Z");
		const state = lockStateOf({ customMetadata, uploaded });
		expect(state && isStateLocked(state, new Date("2030-01-01T00:00:30Z"))).toBe(true);
		expect(state && isStateLocked(state, new Date("2030-01-01T00:01:00Z"))).toBe(false);
		const noUpload = lockStateOf({ customMetadata });
		expect(noUpload && isStateLocked(noUpload, new Date("2999-01-01T00:00:00Z"))).toBe(true);
	});
});
