import { createGrantClient, createWorkerClient, DevulturApiError } from "@devultur/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lockedFixture } from "../object-lock/worker-fixture";
import { TEST_WORKER_SECRET } from "../plugins/worker-secret-auth-test-env";
import { withSignature } from "../test-fixtures";

// `@devultur/core`'s grant clients against `createWorker()` with the default plugins: the owner issues a grant with the
// Worker secret, and the bearer, holding only the grant, reads the head, issues links and deletes the file.
const BASE = "https://media.example";
const BYTES = withSignature("application/zip", "bundle bytes");

function workerFetch() {
	vi.spyOn(console, "log").mockImplementation(() => {});
	const fixture = lockedFixture();
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
		fixture.app.request(new Request(input, init), undefined, fixture.env as never, fixture.executionCtx as never),
	);
	return { ...fixture, owner: createWorkerClient(TEST_WORKER_SECRET, BASE) };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("download grants through the clients", () => {
	it("hands a file over without the Worker's credential", async () => {
		const { owner, mediaBucket } = workerFetch();
		const uploaded = await owner.uploads.uploadAsset(new Blob([BYTES], { type: "application/zip" }), {
			path: "exports/42/bundle.zip",
			visibility: "private",
			expiresIn: 7 * 24 * 60 * 60,
		});
		const issued = await owner.files.createDownloadGrant(uploaded.key, {
			link: { maxExpiresIn: 300, maxUses: 1 },
			maxLinks: 2,
			canDelete: true,
			metadata: { exportId: "42" },
		});
		expect(issued.expiresAt).toBe(uploaded.expiresAt);

		const file = createGrantClient(issued.grant, BASE);
		expect(await file.head()).toMatchObject({
			key: uploaded.key,
			size: BYTES.byteLength,
			sha256: uploaded.sha256,
			encrypted: false,
			metadata: { exportId: "42" },
		});

		const first = await file.createDownloadLink({ expiresIn: 300, filename: "export.zip" });
		const redeemed = await fetch(first.url);
		expect(new Uint8Array(await redeemed.arrayBuffer())).toEqual(BYTES);
		const second = await file.createDownloadLink();
		await expect(file.createDownloadLink()).rejects.toMatchObject({ status: 410, code: "grant_exhausted" });
		expect((await owner.files.listDownloadGrants(uploaded.key))[0]).toMatchObject({ id: issued.id, linksIssued: 2 });

		await file.delete();
		expect(mediaBucket.objects.has(uploaded.key)).toBe(false);
		expect((await fetch(second.url)).status).toBe(404);
		expect(await file.head()).toBeNull();
	});

	it("dies when its owner revokes it", async () => {
		const { owner } = workerFetch();
		const uploaded = await owner.uploads.uploadAsset(new Blob([BYTES]), { path: "exports/revoked.zip" });
		const issued = await owner.files.createDownloadGrant(uploaded.key);
		const file = createGrantClient(issued.grant, BASE);

		await owner.files.revokeDownloadGrant(issued.id);
		const refused = await file.createDownloadLink().catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(DevulturApiError);
		expect(refused).toMatchObject({ status: 410, code: "grant_gone" });
		expect(await file.head()).toBeNull();
	});
});
