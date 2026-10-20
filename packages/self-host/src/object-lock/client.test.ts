import { createWorkerClient, DevulturApiError, HOLD_PAGE_SIZE } from "@devultur/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerPlugin } from "../plugin";
import { TEST_WORKER_SECRET } from "../plugins/worker-secret-auth-test-env";
import { CAPTION_KEY, lockedFixture, RAW_KEY } from "./worker-fixture";

// `@devultur/core`'s lock client against the in-memory Worker: `fetch` to the Worker's origin goes to the app.
const BASE = "https://media.example";

function clientWith(plugins: WorkerPlugin[] = []) {
	vi.spyOn(console, "log").mockImplementation(() => {});
	const fixture = lockedFixture({ plugins });
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
		fixture.app.request(
			new Request(input, init),
			undefined,
			fixture.env as never,
			{
				waitUntil() {},
				passThroughOnException() {},
			} as never,
		),
	);
	return { ...fixture, client: createWorkerClient(TEST_WORKER_SECRET, BASE) };
}

const rejection = (promise: Promise<unknown>) =>
	promise.then(
		() => {
			throw new Error("expected a rejection");
		},
		(error: unknown) => error as DevulturApiError,
	);

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("WorkerClient.lock", () => {
	it("reads and extends a lock", async () => {
		const { client } = clientWith();
		expect(await client.lock.get(RAW_KEY)).toMatchObject({ mode: "compliance", source: "upload" });
		const extended = await client.lock.set(RAW_KEY, { until: "2999-06-01T00:00:00Z" });
		expect(extended).toMatchObject({ until: "2999-06-01T00:00:00.000Z", source: "sidecar", revision: 1 });
	});

	it("surfaces the Worker's refusals as DevulturApiError with code and details", async () => {
		const { client } = clientWith();
		const shorten = await rejection(client.lock.set(RAW_KEY, { until: "2998-01-01T00:00:00Z" }));
		expect(shorten).toBeInstanceOf(DevulturApiError);
		expect(shorten).toMatchObject({ status: 409, code: "compliance_extend_only", details: { key: RAW_KEY } });

		const deleted = await rejection(client.delete(RAW_KEY));
		expect(deleted).toMatchObject({
			status: 409,
			code: "retention_active",
			details: { key: RAW_KEY, mode: "compliance", until: "2999-01-01T00:00:00.000Z", hold: false },
		});

		const missing = await rejection(client.lock.get("private/file/none/x.pdf"));
		expect(missing).toMatchObject({ status: 404 });
		const reserved = await rejection(client.lock.get("__lock/x"));
		expect(reserved).toMatchObject({ status: 400, code: "reserved_key" });
	});

	it("needs bypassGovernance and an approving hook to shorten a governance retention", async () => {
		const { client, mediaBucket } = clientWith([{ name: "ok", authorizeLockChange: () => ({ allow: true }) }]);
		const key = "private/file/g/g.pdf";
		mediaBucket.objects.set(key, { bytes: new Uint8Array(1), httpMetadata: {}, customMetadata: {} });
		await client.lock.set(key, { mode: "governance", until: "2999-01-01T00:00:00Z" });
		expect(await rejection(client.lock.set(key, { until: "2998-01-01T00:00:00Z" }))).toMatchObject({
			status: 403,
			code: "lock_privilege_required",
		});
		expect(await client.lock.set(key, { remove: true, bypassGovernance: true })).toMatchObject({ mode: null });
	});

	it("holds and releases one page, or every page of a prefix or a long key list", async () => {
		const { client, mediaBucket } = clientWith();
		expect(await client.lock.hold([RAW_KEY, CAPTION_KEY])).toEqual({ updated: [RAW_KEY, CAPTION_KEY], skipped: [] });
		expect(await client.lock.release([CAPTION_KEY])).toEqual({ updated: [CAPTION_KEY], skipped: [] });

		const keys = Array.from({ length: HOLD_PAGE_SIZE + 3 }, (_, index) => `private/asset/x/${index}.bin`);
		for (const key of keys)
			mediaBucket.objects.set(key, { bytes: new Uint8Array(1), httpMetadata: {}, customMetadata: {} });
		const held: string[] = [];
		let pages = 0;
		for await (const page of client.lock.holdAll({ prefix: "private/asset/x/" })) {
			held.push(...page.updated);
			pages += 1;
		}
		expect(pages).toBe(2);
		expect(held.sort()).toEqual([...keys].sort());

		const released: string[] = [];
		for await (const page of client.lock.releaseAll(keys)) released.push(...page.updated);
		expect(released).toEqual(keys);
	});
});

describe("upload options", () => {
	it("passes lock and hold on createUploadUrl, uploadFile, uploadAsset and upload tokens", async () => {
		const { client, mediaBucket } = clientWith();
		const created = await client.createUploadUrl({ filename: "a.pdf", contentType: "application/pdf", hold: true });
		await fetch(created.uploadUrl, { method: "PUT", body: "a", headers: { "Content-Type": "application/pdf" } });
		expect(mediaBucket.objects.get(created.key)?.customMetadata.lock).toBe('{"hold":true}');

		const file = new File(["b"], "b.pdf", { type: "application/pdf" });
		const uploaded = await client.uploadFile(file, { lock: { retention: { mode: "governance", period: 60 } } });
		expect(await client.lock.get(uploaded.key)).toMatchObject({ mode: "governance", period: 60, source: "upload" });

		const asset = await client.uploads.uploadAsset(new Blob(["c"]), { path: "docs/c.pdf", hold: true });
		expect(await client.lock.get(asset.key)).toMatchObject({ hold: true });

		const token = await client.uploads.createToken({ prefix: "docs/", lock: { hold: true } });
		expect(token).toMatchObject({ lock: { hold: true } });
	});

	it("refuses an expiry before the lock ends, and a token minimum the upload loosens", async () => {
		const { client } = clientWith();
		const conflict = await rejection(
			client.uploads.uploadAsset(new Blob(["d"]), { path: "docs/d.pdf", hold: true, expiresIn: 60 }),
		);
		expect(conflict).toMatchObject({ status: 400, code: "lock_conflicts_expiry" });

		const { token } = await client.uploads.createToken({ prefix: "docs/", lock: { hold: true } });
		const withToken = createWorkerClient(token, BASE);
		const loosened = await rejection(
			withToken.uploads.uploadAsset(new Blob(["e"]), { path: "docs/e.pdf", hold: false }),
		);
		expect(loosened).toMatchObject({ status: 403, code: "lock_below_minimum" });
	});
});
