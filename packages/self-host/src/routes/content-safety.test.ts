import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateRequestState } from "../request-state";
import type { WorkerApp } from "../types";
import { contentSafety, isSafeInlineType } from "./content-safety";
import { media } from "./media";

const BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

interface StoredObject {
	contentType: string;
	contentDisposition?: string;
}

function makeBucket(objects: Record<string, StoredObject>) {
	return {
		get: async (fullKey: string, options?: { range?: { offset: number; length: number } }) => {
			const stored = objects[fullKey.replace(/^prefix-a\//, "")];
			if (!stored) return null;
			const range = options?.range;
			const bytes = range ? BYTES.slice(range.offset, range.offset + range.length) : BYTES;
			return {
				httpMetadata: { contentType: stored.contentType, contentDisposition: stored.contentDisposition },
				size: BYTES.byteLength,
				httpEtag: '"e"',
				customMetadata: {},
				body: new Blob([bytes]).stream(),
			};
		},
	};
}

function makeCache(cached: Response | null) {
	const puts: Response[] = [];
	const cache = {
		match: vi.fn(async () => cached?.clone() ?? undefined),
		put: vi.fn(async (_request: unknown, response: Response) => {
			puts.push(response);
		}),
	};
	return { cache, puts };
}

async function request(key: string, stored: StoredObject, headers?: Record<string, string>) {
	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		updateRequestState(context, { storagePrefix: "prefix-a/" });
		await next();
	});
	app.route("/v1/media", media);
	const env = { MEDIA_BUCKET: makeBucket({ [key]: stored }), DELIVERY_SIGN_SECRET: "s" } as never;
	const waits: Promise<unknown>[] = [];
	const res = await app.request(`https://acme.example.com/v1/media/${key}`, { headers }, env, {
		waitUntil: (promise: Promise<unknown>) => waits.push(promise),
		passThroughOnException() {},
	} as never);
	await Promise.all(waits);
	return res;
}

afterEach(() => vi.unstubAllGlobals());

describe("delivery content safety", () => {
	it.each([
		["public/file/f1/page.html", "text/html; charset=utf-8"],
		["public/file/f1/logo.svg", "image/svg+xml"],
		["public/file/f1/page.xhtml", "application/xhtml+xml"],
		["public/file/f1/feed.xml", "application/xml"],
		["public/file/f1/feed.rss", "text/xml"],
		["public/file/f1/app.js", "application/javascript"],
		["public/file/f1/blob.bin", "application/x-unknown"],
	])("sandboxes %s (%s) and serves it as an attachment", async (key, contentType) => {
		const res = await request(key, { contentType });

		expect(res.status).toBe(200);
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
		expect(res.headers.get("Content-Disposition")).toMatch(/^attachment/);
	});

	it("keeps the stored filename when turning an inline disposition into an attachment", async () => {
		const res = await request("public/file/f1/page.html", {
			contentType: "text/html",
			contentDisposition: "inline; filename*=UTF-8''Reporte%20final.html",
		});

		expect(res.headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''Reporte%20final.html");
	});

	it.each([
		["public/image/i1/photo.png", "image/png"],
		["public/video/v1/raw/1-caps.mp4", "video/mp4"],
		["public/video/v1/hls/720p/seg-001.ts", "video/mp2t"],
		["public/video/v1/hls/master.m3u8", "application/vnd.apple.mpegurl"],
		["public/video/v1/captions/es.vtt", "text/vtt"],
		["public/file/f1/note.mp3", "audio/mpeg"],
		["public/file/f1/form.pdf", "application/pdf"],
		["public/file/f1/data.json", "application/json"],
	])("leaves %s (%s) inline, with nosniff", async (key, contentType) => {
		const res = await request(key, { contentType });

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe(contentType);
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Content-Security-Policy")).toBeNull();
		expect(res.headers.get("Content-Disposition")).toBeNull();
	});

	it("keeps range requests working, for safe and sandboxed types alike", async () => {
		const video = await request("public/video/v1/raw/1-caps.mp4", { contentType: "video/mp4" }, { Range: "bytes=0-1" });
		const page = await request("public/file/f1/page.html", { contentType: "text/html" }, { Range: "bytes=0-1" });

		expect(video.status).toBe(206);
		expect(video.headers.get("Content-Security-Policy")).toBeNull();
		expect(page.status).toBe(206);
		expect(page.headers.get("Content-Range")).toBe("bytes 0-1/10");
		expect(page.headers.get("Content-Security-Policy")).toBe("sandbox");
	});

	it("stores the headers in the edge copy", async () => {
		const { cache, puts } = makeCache(null);
		vi.stubGlobal("caches", { default: cache });

		await request("public/file/f1/page.html", { contentType: "text/html" });

		expect(puts).toHaveLength(1);
		expect(puts[0]!.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(puts[0]!.headers.get("Content-Security-Policy")).toBe("sandbox");
		expect(puts[0]!.headers.get("Content-Disposition")).toMatch(/^attachment/);
	});

	it("adds the headers to an edge copy cached before them", async () => {
		const { cache } = makeCache(
			new Response("<script>", { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=60" } }),
		);
		vi.stubGlobal("caches", { default: cache });

		const res = await request("public/file/f1/page.html", { contentType: "text/html" });

		expect(await res.text()).toBe("<script>");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
	});

	it("applies to any router it guards (download links use it)", async () => {
		const app = new Hono();
		app.use("*", contentSafety);
		app.get("/:id", () => new Response("<svg>", { headers: { "Content-Type": "image/svg+xml" } }));

		const res = await app.request("https://acme.example.com/abc");

		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
		expect(res.headers.get("Content-Disposition")).toMatch(/^attachment/);
	});
});

describe("isSafeInlineType", () => {
	it("treats a missing type as unsafe", () => {
		expect(isSafeInlineType(null)).toBe(false);
		expect(isSafeInlineType("")).toBe(false);
	});
});
