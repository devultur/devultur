// The public edge copy never serves past expiry or carries owner data: `caches` doesn't exist in Node, so these stub a
// `caches.default` that stores what `put` gets (the seam `publicEdgeCache()` reads at call time).
import { afterEach, describe, expect, it, vi } from "vitest";
import { lockedFixture } from "../object-lock/worker-fixture";
import { edgeCopyTtl, putEdgeCopy } from "./edge-cache";

const PUBLIC_KEY = "public/file/p1/doc.pdf";
const RETAINED = JSON.stringify({ retention: { mode: "compliance", until: "2999-01-01T00:00:00Z" }, hold: false });

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function stubEdgeCache() {
	const copies = new Map<string, Response>();
	const urlOf = (request: Request | string) => (typeof request === "string" ? request : request.url);
	const cache = {
		match: async (request: Request | string) => copies.get(urlOf(request))?.clone(),
		put: async (request: Request | string, response: Response) => {
			copies.set(urlOf(request), new Response(await response.arrayBuffer(), response));
		},
		delete: async () => true,
	};
	vi.stubGlobal("caches", { default: cache });
	return copies;
}

function publicFile(customMetadata: Record<string, string>) {
	const fixture = lockedFixture();
	fixture.mediaBucket.objects.set(PUBLIC_KEY, {
		bytes: new TextEncoder().encode("pdf"),
		httpMetadata: { contentType: "application/pdf", cacheControl: "public, max-age=3600" },
		customMetadata,
	});
	const viewerGet = () =>
		fixture.app.request(
			`https://media.example/v1/media/${PUBLIC_KEY}`,
			{},
			fixture.env as never,
			fixture.executionCtx as never,
		);
	const ownerGet = () => fixture.send(`/v1/media/${PUBLIC_KEY}`);
	return { ...fixture, viewerGet, ownerGet };
}

describe("an owner read never feeds the public edge copy", () => {
	it("an expired, retained public file read by its owner stays 410 for viewers", async () => {
		const copies = stubEdgeCache();
		const file = publicFile({ expiresAt: String(Date.now() - 1000), lock: RETAINED });

		const owner = await file.ownerGet();
		expect(owner.status).toBe(200);
		await file.settle();

		expect(copies.size).toBe(0);
		expect((await file.viewerGet()).status).toBe(410);
	});

	it("a locked public file's owner read carries the lock headers, privately, and caches nothing", async () => {
		const copies = stubEdgeCache();
		const file = publicFile({ lock: RETAINED });

		const owner = await file.ownerGet();
		expect(owner.headers.get("x-devultur-lock-until")).toBeTruthy();
		expect(owner.headers.get("Cache-Control")).toMatch(/^private/);
		await file.settle();
		expect(copies.size).toBe(0);

		const viewer = await file.viewerGet();
		await file.settle();
		expect(viewer.headers.get("x-devultur-lock-until")).toBeNull();
		const [copy] = copies.values();
		expect(copy?.headers.get("x-devultur-lock-until")).toBeNull();
	});
});

describe("a public edge copy ends at its object's expiresAt", () => {
	it("caps the copy's TTL at the expiry and ignores the copy once it passes", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const copies = stubEdgeCache();
		const file = publicFile({ expiresAt: String(Date.now() + 10_000) });

		expect((await file.viewerGet()).status).toBe(200);
		await file.settle();
		const [copy] = copies.values();
		const maxAge = Number(/max-age=(\d+)/.exec(copy?.headers.get("Cache-Control") ?? "")?.[1]);
		expect(maxAge).toBeGreaterThan(0);
		expect(maxAge).toBeLessThanOrEqual(10);

		vi.setSystemTime(Date.now() + 11_000);
		expect((await file.viewerGet()).status).toBe(410);
	});

	it("stores nothing for an object that expires within the second", () => {
		expect(edgeCopyTtl({ cacheControl: "public, max-age=3600", expiresAt: Date.now() + 500 })).toBe(0);
	});

	it("never stores a response carrying owner-only lock headers", async () => {
		const put = vi.fn();
		const target = {
			cache: { put } as unknown as Cache,
			cacheKey: "https://media.example/v1/media/public/file/a/a.pdf",
			storagePrefix: "",
			virtualKey: "public/file/a/a.pdf",
			cacheControl: "public, max-age=3600",
		};
		await putEdgeCopy(target, null, new Headers({ "x-devultur-lock-hold": "true" }));
		expect(put).not.toHaveBeenCalled();
	});
});
