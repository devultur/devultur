import { CACHE_CONTROL_PRESETS, DEFAULT_ASSET_CACHE_CONTROL } from "@devultur/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportsWorker } from "../exports-test-harness";
import { edgeCacheTag } from "./edge-cache";

// Public files with a client-supplied path (a sync script): per-object `Cache-Control` (explicit, a prefix rule,
// or the default), overwrite, the edge TTL derived from `max-age`, and the edge copy with its purge tags.

type Worker = ReturnType<typeof exportsWorker>;
const CSS = new TextEncoder().encode("body{}");
const PROJECT_PREFIX = "prefix-a/";

async function uploadPublic(worker: Worker, body: Record<string, unknown>, bytes: Uint8Array<ArrayBuffer> = CSS) {
	const created = await worker.postJson("/v1/upload", { contentType: "text/css", visibility: "public", ...body });
	if (created.status !== 200) return { created, put: null };
	const { uploadUrl } = (await created.clone().json()) as { uploadUrl: string };
	const put = await worker.send(uploadUrl, { method: "PUT", body: bytes, headers: { "Content-Type": "text/css" } });
	return { created, put };
}

const storedCacheControl = (worker: Worker, key: string) =>
	worker.mediaBucket.objects.get(`${PROJECT_PREFIX}${key}`)?.httpMetadata.cacheControl;

function makeCache(cached: Response | null = null) {
	const puts: Array<{ url: string; response: Response }> = [];
	const cache = {
		match: vi.fn(async () => cached?.clone() ?? undefined),
		put: vi.fn(async (url: string, response: Response) => void puts.push({ url, response })),
	};
	vi.stubGlobal("caches", { default: cache });
	return { cache, puts };
}

afterEach(() => vi.unstubAllGlobals());

describe("Cache-Control per object", () => {
	it("persists a preset and serves it back", async () => {
		const worker = exportsWorker();
		const { put } = await uploadPublic(worker, { path: "site/app.123.css", cacheControl: "immutable" });
		expect(put?.status).toBe(200);
		expect(storedCacheControl(worker, "public/asset/site/app.123.css")).toBe(CACHE_CONTROL_PRESETS.immutable);

		const res = await worker.send("/v1/media/public/asset/site/app.123.css");
		expect(res.headers.get("Cache-Control")).toBe(CACHE_CONTROL_PRESETS.immutable);
	});

	it("persists a validated raw header", async () => {
		const worker = exportsWorker();
		await uploadPublic(worker, { path: "site/a.css", cacheControl: "public,max-age=300" });
		expect(storedCacheControl(worker, "public/asset/site/a.css")).toBe("public, max-age=300");
	});

	it("rejects an invalid header before creating the upload", async () => {
		const worker = exportsWorker();
		const { created } = await uploadPublic(worker, { path: "site/a.css", cacheControl: "public, x-evil=1" });
		expect(created.status).toBe(400);
		expect(await created.json()).toMatchObject({ code: "invalid_cache_control" });
		expect(worker.kv.entries.size).toBe(0);
	});

	it("falls back to the configured rule with the longest prefix, then to the short default", async () => {
		const worker = exportsWorker({
			cacheRules: [
				{ prefix: "site/", cacheControl: CACHE_CONTROL_PRESETS.revalidate },
				{ prefix: "site/static/", cacheControl: CACHE_CONTROL_PRESETS.immutable },
			],
		});
		await uploadPublic(worker, { path: "site/static/app.css" });
		await uploadPublic(worker, { path: "site/index.css" });
		await uploadPublic(worker, { path: "other/x.css" });
		expect(storedCacheControl(worker, "public/asset/site/static/app.css")).toBe(CACHE_CONTROL_PRESETS.immutable);
		expect(storedCacheControl(worker, "public/asset/site/index.css")).toBe(CACHE_CONTROL_PRESETS.revalidate);
		expect(storedCacheControl(worker, "public/asset/other/x.css")).toBe(DEFAULT_ASSET_CACHE_CONTROL);
	});

	it("keeps server-generated ids immutable", async () => {
		const worker = exportsWorker();
		const created = await worker.postJson("/v1/upload", {
			filename: "a.pdf",
			contentType: "application/pdf",
			visibility: "public",
			cacheControl: "no-cache",
		});
		const { key, uploadUrl } = (await created.json()) as { key: string; uploadUrl: string };
		await worker.send(uploadUrl, { method: "PUT", body: CSS, headers: { "Content-Type": "application/pdf" } });
		expect(storedCacheControl(worker, key)).toBeUndefined();
		const res = await worker.send(`/v1/media/${key}`);
		expect(res.headers.get("Cache-Control")).toBe(CACHE_CONTROL_PRESETS.immutable);
	});

	it("serves a private asset's header without shared-cache directives", async () => {
		const worker = exportsWorker({ ownerAccess: true });
		const created = await worker.postJson("/v1/upload", {
			path: "exports/a.zip",
			contentType: "application/zip",
			cacheControl: "public, max-age=60, s-maxage=600",
		});
		const { uploadUrl } = (await created.json()) as { uploadUrl: string };
		await worker.send(uploadUrl, { method: "PUT", body: CSS, headers: { "Content-Type": "application/zip" } });
		const res = await worker.send("/v1/media/private/asset/exports/a.zip");
		expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
	});
});

describe("overwrite", () => {
	it("replaces the object and its Cache-Control only with overwrite: true", async () => {
		const worker = exportsWorker();
		await uploadPublic(worker, { path: "site/a.css", cacheControl: "revalidate" });
		const conflict = await uploadPublic(worker, { path: "site/a.css" }, new TextEncoder().encode("v2"));
		expect(conflict.created.status).toBe(409);

		const { put } = await uploadPublic(
			worker,
			{ path: "site/a.css", overwrite: true, cacheControl: "no-cache" },
			new TextEncoder().encode("v2"),
		);
		expect(put?.status).toBe(200);
		const res = await worker.send("/v1/media/public/asset/site/a.css");
		expect(await res.text()).toBe("v2");
		expect(res.headers.get("Cache-Control")).toBe("public, no-cache");
	});
});

describe("overwrite and image variants", () => {
	it("drops the variants generated from the replaced bytes", async () => {
		const worker = exportsWorker();
		await uploadPublic(worker, { path: "site/logo.png" });
		const variantKey = `${PROJECT_PREFIX}public/asset/site/logo.png/__variants/w100_h_fit-_q.webp`;
		worker.mediaBucket.objects.set(variantKey, { bytes: CSS, httpMetadata: {}, customMetadata: {} });

		await uploadPublic(worker, { path: "site/logo.png", overwrite: true }, new TextEncoder().encode("v2"));
		expect(worker.mediaBucket.objects.has(variantKey)).toBe(false);
		expect(worker.mediaBucket.objects.has(`${PROJECT_PREFIX}public/asset/site/logo.png`)).toBe(true);
	});

	it("keeps the variants of a first upload's neighbours", async () => {
		const worker = exportsWorker();
		const neighbourVariant = `${PROJECT_PREFIX}public/asset/site/a.png/__variants/w1_h_fit-_q.webp`;
		worker.mediaBucket.objects.set(neighbourVariant, { bytes: CSS, httpMetadata: {}, customMetadata: {} });
		await uploadPublic(worker, { path: "site/b.png", overwrite: true });
		expect(worker.mediaBucket.objects.has(neighbourVariant)).toBe(true);
	});
});

describe("edge cache", () => {
	it("stores the copy with the TTL from max-age, the purge tags and the original header", async () => {
		const worker = exportsWorker();
		await uploadPublic(worker, { path: "site/a.css" });
		const { puts } = makeCache();

		await worker.send("/v1/media/public/asset/site/a.css");
		await worker.settle();
		expect(puts).toHaveLength(1);
		const copy = puts[0].response.headers;
		expect(copy.get("Cache-Control")).toBe("public, max-age=60");
		expect(copy.get("x-devultur-cache-control")).toBe(DEFAULT_ASSET_CACHE_CONTROL);
		const objectTag = await edgeCacheTag(PROJECT_PREFIX, "public/asset/site/a.css");
		expect(copy.get("Cache-Tag")).toBe(`${objectTag},dv-p-prefix-a`);
	});

	it("caps the edge TTL of immutable objects", async () => {
		const worker = exportsWorker();
		await uploadPublic(worker, { path: "site/a.1.css", cacheControl: "immutable" });
		const { puts } = makeCache();
		await worker.send("/v1/media/public/asset/site/a.1.css");
		await worker.settle();
		expect(puts[0].response.headers.get("Cache-Control")).toBe("public, max-age=604800");
	});

	it("does not store no-cache objects at the edge", async () => {
		const worker = exportsWorker();
		await uploadPublic(worker, { path: "site/index.css", cacheControl: "no-cache" });
		const { puts } = makeCache();
		const res = await worker.send("/v1/media/public/asset/site/index.css");
		await worker.settle();
		expect(res.status).toBe(200);
		expect(puts).toHaveLength(0);
	});

	it("round-trips the object's header through an edge hit", async () => {
		const worker = exportsWorker();
		await uploadPublic(worker, { path: "site/a.css", cacheControl: "revalidate" });
		const { puts } = makeCache();
		await worker.send("/v1/media/public/asset/site/a.css");
		await worker.settle();

		makeCache(puts[0].response);
		const hit = await worker.send("/v1/media/public/asset/site/a.css");
		expect(hit.headers.get("Cache-Control")).toBe(CACHE_CONTROL_PRESETS.revalidate);
		expect(hit.headers.get("Cache-Tag")).toBeNull();
		expect(await hit.text()).toBe("body{}");
	});

	it("tags every object of a generated media with the same purge unit", async () => {
		expect(await edgeCacheTag("p/", "public/video/v1/raw/a.mp4")).toBe(
			await edgeCacheTag("p/", "public/video/v1/hls/720p/seg-1.ts"),
		);
		expect(await edgeCacheTag("p/", "public/asset/a.css")).not.toBe(await edgeCacheTag("p/", "public/asset/b.css"));
	});
});
