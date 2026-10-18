import { describe, expect, it } from "vitest";
import { exportsWorker } from "../exports-test-harness";
import { parseListCursor, parseListPrefix } from "./assets";

// `GET /v1/assets`: the listing a sync script compares against disk. Only the `asset/` namespace of the storage prefix, filtered by prefix, with a single pagination that walks private then public entries.

type Worker = ReturnType<typeof exportsWorker>;

function seed(worker: Worker, key: string, bytes: string, extra: { sha256?: string; cacheControl?: string } = {}) {
	worker.mediaBucket.objects.set(`prefix-a/${key}`, {
		bytes: new TextEncoder().encode(bytes),
		httpMetadata: extra.cacheControl ? { cacheControl: extra.cacheControl } : {},
		customMetadata: extra.sha256 ? { sha256: extra.sha256, sha256Verified: "true" } : {},
	});
}

interface Listing {
	objects: Array<Record<string, unknown>>;
	cursor: string | null;
}

async function list(worker: Worker, query: string): Promise<Listing> {
	const res = await worker.send(`/v1/assets${query}`);
	expect(res.status).toBe(200);
	return (await res.json()) as Listing;
}

function seededWorker() {
	const worker = exportsWorker();
	seed(worker, "public/asset/site/app.css", "body{}", { sha256: "a".repeat(64), cacheControl: "public, max-age=60" });
	seed(worker, "public/asset/site/img/logo.png", "png");
	seed(worker, "public/asset/docs/a.pdf", "pdf");
	seed(worker, "private/asset/site/secret.txt", "s");
	seed(worker, "public/image/abc/photo.png", "generated");
	worker.mediaBucket.objects.set("prefix-b/public/asset/site/other-prefix.css", {
		bytes: new Uint8Array(1),
		httpMetadata: {},
		customMetadata: {},
	});
	return worker;
}

describe("GET /v1/assets", () => {
	it("lists the prefix inside the storage prefix's asset namespace with the sync fields", async () => {
		const listing = await list(seededWorker(), "?prefix=site/&visibility=public");
		expect(listing.cursor).toBeNull();
		expect(listing.objects.map((object) => object.key)).toEqual([
			"public/asset/site/app.css",
			"public/asset/site/img/logo.png",
		]);
		expect(listing.objects[0]).toMatchObject({
			path: "site/app.css",
			size: 6,
			sha256: "a".repeat(64),
			sha256Verified: true,
			cacheControl: "public, max-age=60",
			visibility: "public",
			uploaded: new Date(0).toISOString(),
		});
		expect(listing.objects[1]).toMatchObject({ sha256: null, sha256Verified: false, cacheControl: null });
	});

	it("walks private then public with one cursor when no visibility is given", async () => {
		const worker = seededWorker();
		const first = await list(worker, "?prefix=site&limit=1");
		expect(first.objects.map((object) => object.key)).toEqual(["private/asset/site/secret.txt"]);
		expect(first.cursor).toBe("public:");

		const keys: unknown[] = [];
		let cursor: string | null = first.cursor;
		while (cursor) {
			const page = await list(worker, `?prefix=site&limit=1&cursor=${encodeURIComponent(cursor)}`);
			keys.push(...page.objects.map((object) => object.key));
			cursor = page.cursor;
		}
		expect(keys).toEqual(["public/asset/site/app.css", "public/asset/site/img/logo.png"]);
	});

	it("never lists generated media or other prefixes", async () => {
		const listing = await list(seededWorker(), "");
		const keys = listing.objects.map((object) => object.key);
		expect(keys).not.toContain("public/image/abc/photo.png");
		expect(keys.some((key) => String(key).includes("other-prefix"))).toBe(false);
	});

	it("skips expired files", async () => {
		const worker = exportsWorker();
		worker.mediaBucket.objects.set("prefix-a/public/asset/site/old.css", {
			bytes: new Uint8Array(1),
			httpMetadata: {},
			customMetadata: { expiresAt: "1" },
		});
		expect((await list(worker, "?prefix=site/")).objects).toEqual([]);
	});

	it.each([
		"?prefix=../x",
		"?prefix=public/asset/",
		"?cursor=bogus",
		"?visibility=secret",
	])("rejects %s", async (query) => {
		const res = await seededWorker().send(`/v1/assets${query}`);
		expect(res.status).toBe(400);
	});
});

describe("list helpers", () => {
	it("parses prefixes and cursors", () => {
		expect(parseListPrefix(undefined)).toBe("");
		expect(parseListPrefix("site")).toBe("site/");
		expect(parseListCursor("public:abc:def", ["private", "public"])).toEqual({
			visibility: "public",
			cursor: "abc:def",
		});
		expect(parseListCursor("private:", ["public"])).toBeNull();
	});
});
