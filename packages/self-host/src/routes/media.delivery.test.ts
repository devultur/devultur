import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateRequestState } from "../request-state";
import type { WorkerApp } from "../types";
import { media } from "./media";

// Progressive video delivery (MP4 in a <video>): Safari requires `Accept-Ranges` + well-formed
// ranges, and a public site's background `<video>` gets requested thousands of times → cache on the edge.

const BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

function makeObject(bytes: Uint8Array<ArrayBuffer>) {
	return {
		httpMetadata: { contentType: "video/mp4" },
		size: bytes.byteLength,
		httpEtag: '"e"',
		customMetadata: {},
		body: new Blob([bytes]).stream(),
	};
}

function makeBucket() {
	const gets: Array<{ key: string; range?: { offset: number; length: number } }> = [];
	const bucket = {
		get: async (key: string, options?: { range?: { offset: number; length: number } }) => {
			gets.push({ key, range: options?.range });
			if (!key.includes("/video/")) return null;
			const range = options?.range;
			return makeObject(range ? BYTES.slice(range.offset, range.offset + range.length) : BYTES);
		},
		head: async (key: string) => (key.includes("/video/") ? { ...makeObject(BYTES), body: undefined } : null),
	};
	return { bucket, gets };
}

function makeCache(cached: Response | null) {
	const puts: Array<{ url: string; response: Response }> = [];
	const cache = {
		match: vi.fn(async () => cached?.clone() ?? undefined),
		put: vi.fn(async (request: Request | string, response: Response) => {
			puts.push({ url: typeof request === "string" ? request : request.url, response });
		}),
	};
	return { cache, puts };
}

async function request(path: string, headers?: Record<string, string>) {
	const { bucket, gets } = makeBucket();
	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		updateRequestState(context, { storagePrefix: "prefix-a/" });
		await next();
	});
	app.route("/v1/media", media);
	const waits: Promise<unknown>[] = [];
	const env = { MEDIA_BUCKET: bucket, DELIVERY_SIGN_SECRET: "s" } as unknown as WorkerApp["Bindings"];
	const res = await app.request(`https://acme.example.com${path}`, { headers }, env, {
		waitUntil: (promise: Promise<unknown>) => waits.push(promise),
		passThroughOnException() {},
	} as never);
	await Promise.all(waits);
	return { res, gets };
}

const VIDEO_PATH = "/v1/media/public/video/vid1/raw/1-caps.mp4";

afterEach(() => vi.unstubAllGlobals());

describe("ranged delivery", () => {
	it("advertises byte ranges on a full response", async () => {
		const { res } = await request(VIDEO_PATH);
		expect(res.status).toBe(200);
		expect(res.headers.get("Accept-Ranges")).toBe("bytes");
	});

	it("serves an explicit range as 206", async () => {
		const { res } = await request(VIDEO_PATH, { Range: "bytes=0-1" });
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Range")).toBe("bytes 0-1/10");
		expect(res.headers.get("Accept-Ranges")).toBe("bytes");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0, 1]));
	});

	it("serves a suffix range (the last N bytes)", async () => {
		const { res } = await request(VIDEO_PATH, { Range: "bytes=-4" });
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Range")).toBe("bytes 6-9/10");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([6, 7, 8, 9]));
	});

	it("answers 416 for a range that starts past the end", async () => {
		const { res } = await request(VIDEO_PATH, { Range: "bytes=20-" });
		expect(res.status).toBe(416);
		expect(res.headers.get("Content-Range")).toBe("bytes */10");
	});
});

describe("edge cache for public media", () => {
	it("serves a cache hit without touching the bucket", async () => {
		const { cache } = makeCache(
			new Response("cached", {
				status: 200,
				headers: {
					"Content-Type": "video/mp4",
					"Cache-Control": "public, max-age=604800",
					"x-devultur-cache-control": "public, max-age=31536000, immutable",
					"Cache-Tag": "dv-o-abc,dv-p-prefix-a",
				},
			}),
		);
		vi.stubGlobal("caches", { default: cache });

		const { res, gets } = await request(VIDEO_PATH);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("cached");
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
		expect(res.headers.get("Cache-Tag")).toBeNull();
		expect(res.headers.get("x-devultur-cache-control")).toBeNull();
		expect(gets).toEqual([]);
	});

	it("stores the full object on a miss, keyed without the Range header", async () => {
		const { cache, puts } = makeCache(null);
		vi.stubGlobal("caches", { default: cache });

		const { res } = await request(VIDEO_PATH, { Range: "bytes=0-1" });
		expect(res.status).toBe(206);
		expect(puts).toHaveLength(1);
		expect(puts[0].url).toBe(`https://acme.example.com${VIDEO_PATH}`);
		expect(puts[0].response.status).toBe(200);
		expect(puts[0].response.headers.get("Cache-Control")).toBe("public, max-age=604800");
		expect(new Uint8Array(await puts[0].response.arrayBuffer())).toEqual(BYTES);
	});

	it("never caches private media", async () => {
		const { cache } = makeCache(new Response("cached"));
		vi.stubGlobal("caches", { default: cache });

		const { res } = await request("/v1/media/private/video/vid1/raw/1-caps.mp4");
		expect(res.status).toBe(401);
		expect(cache.match).not.toHaveBeenCalled();
	});
});
