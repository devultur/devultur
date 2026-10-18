import { describe, expect, it, vi } from "vitest";
import type { UploadGrant } from "../export-types";
import { exportsWorker } from "../exports-test-harness";
import { verifyViewerToken } from "../helpers";
import type { PluginHooks } from "../plugin-hooks";
import type { DownloadLinkInfo } from "../route-result";
import { uploadPendingIdOf, uploadPendingKvKey } from "./upload-pending";

// Private exports in self-host: assets with a client path under an upload token's prefix, conditional
// overwrite, TTL (410 when expired), single-use download links (DO), and asset deletion along with its L4 material.

const GRANT: UploadGrant = { tokenId: "jti-1", pathPrefix: "asset/exports/inst-1/", visibility: "private" };
const BYTES = new TextEncoder().encode("zip bytes");

type Worker = ReturnType<typeof exportsWorker>;

const createAsset = (worker: Worker, body: Record<string, unknown>) =>
	worker.postJson("/v1/upload", { contentType: "application/zip", ...body });

async function uploadAsset(worker: Worker, body: Record<string, unknown>) {
	const created = (await (await createAsset(worker, body)).json()) as { key: string; uploadUrl: string };
	const res = await worker.send(created.uploadUrl, {
		method: "PUT",
		body: BYTES,
		headers: { "Content-Type": "application/zip" },
	});
	return { ...created, res };
}

describe("asset uploads with an upload token", () => {
	it("creates the file at {visibility}/asset/{path} inside the token's prefix", async () => {
		const worker = exportsWorker({ uploadGrant: GRANT, context: { owner: "a" } });
		const res = await createAsset(worker, { path: "exports/inst-1/2026/pkg.zip" });
		expect(res.status).toBe(200);
		const created = (await res.json()) as { uploadUrl: string };
		expect(created).toMatchObject({
			key: "private/asset/exports/inst-1/2026/pkg.zip",
			id: "private/asset/exports/inst-1/2026/pkg.zip",
			visibility: "private",
		});
		const pendingKvKey = uploadPendingKvKey(uploadPendingIdOf(created.uploadUrl) ?? "");
		const pending = JSON.parse(worker.kv.entries.get(pendingKvKey) ?? "");
		expect(pending).toMatchObject({ context: { owner: "a" }, isAsset: true, overwrite: false });
	});

	it("stores the config's uploadMetadata on the uploaded object, under the Worker's own entries", async () => {
		const worker = exportsWorker({ uploadGrant: GRANT, uploadMetadata: { origin: "batch-7", sha256: "forged" } });
		const { key, res } = await uploadAsset(worker, { path: "exports/inst-1/meta.zip" });
		expect(res.status).toBe(200);
		const stored = worker.mediaBucket.objects.get(`prefix-a/${key}`);
		expect(stored?.customMetadata).toMatchObject({ origin: "batch-7", sha256Verified: "true" });
		expect(stored?.customMetadata.sha256).not.toBe("forged");
	});

	it("drops the Worker's own keys from the config's uploadMetadata, whatever their case", async () => {
		const worker = exportsWorker({
			uploadGrant: GRANT,
			uploadMetadata: {
				origin: "batch-7",
				security: JSON.stringify({ ipBinding: false }),
				enc: "forged",
				expiresAt: "1",
				SHA256: "forged",
				derivedFrom: "variant",
			},
		});
		const { key, res } = await uploadAsset(worker, { path: "exports/inst-1/reserved.zip" });
		expect(res.status).toBe(200);
		const metadata = worker.mediaBucket.objects.get(`prefix-a/${key}`)?.customMetadata ?? {};
		expect(metadata.origin).toBe("batch-7");
		for (const reserved of ["enc", "expiresAt", "SHA256", "derivedFrom"]) expect(metadata).not.toHaveProperty(reserved);
		expect(metadata.security).not.toBe(JSON.stringify({ ipBinding: false }));
	});

	const escapes: Array<[string, Record<string, unknown>, number, string]> = [
		["a sibling prefix", { path: "exports/inst-2/pkg.zip" }, 403, "token_rejected"],
		["a prefix lookalike", { path: "exports/inst-10/pkg.zip" }, 403, "token_rejected"],
		["`..`", { path: "exports/inst-1/../inst-2/pkg.zip" }, 400, "invalid_path"],
		["an encoded `..`", { path: "exports/inst-1/%2e%2e/inst-2/pkg.zip" }, 400, "invalid_path"],
		["an encoded slash", { path: "exports/inst-1%2Fpkg.zip" }, 400, "invalid_path"],
		["a leading visibility", { path: "public/asset/exports/inst-1/pkg.zip" }, 400, "invalid_path"],
		["the namespace itself", { path: "asset/exports/inst-1/pkg.zip" }, 400, "invalid_path"],
		["an empty segment", { path: "exports//inst-1/pkg.zip" }, 400, "invalid_path"],
		["a visibility swap", { path: "exports/inst-1/pkg.zip", visibility: "public" }, 403, "token_rejected"],
		["no path (generated key)", { filename: "pkg.zip" }, 400, "path_required"],
	];
	for (const [label, body, status, code] of escapes) {
		it(`rejects ${label}`, async () => {
			const worker = exportsWorker({ uploadGrant: GRANT });
			const res = await createAsset(worker, body);
			expect(res.status).toBe(status);
			expect(await res.json()).toMatchObject({ code });
			expect(worker.kv.entries.size).toBe(0);
		});
	}

	it("enforces maxBytes on the declared size and on the PUT", async () => {
		const worker = exportsWorker({ uploadGrant: { ...GRANT, maxBytes: 4 } });
		const declared = await createAsset(worker, { path: "exports/inst-1/big.zip", size: 5 });
		expect(declared.status).toBe(413);
		const { res } = await uploadAsset(worker, { path: "exports/inst-1/small.zip" });
		expect(res.status).toBe(413);
	});

	it("enforces maxFiles (best-effort counter per token)", async () => {
		const worker = exportsWorker({ uploadGrant: { ...GRANT, maxFiles: 1 } });
		expect((await createAsset(worker, { path: "exports/inst-1/a.zip" })).status).toBe(200);
		const second = await createAsset(worker, { path: "exports/inst-1/b.zip" });
		expect(second.status).toBe(403);
		expect(await second.json()).toMatchObject({ code: "max_files_reached" });
	});

	it("applies the token's file TTL as default and ceiling", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const worker = exportsWorker({ uploadGrant: { ...GRANT, fileExpiresIn: 3600 } });
		const byDefault = await createAsset(worker, { path: "exports/inst-1/a.zip" });
		expect(await byDefault.json()).toMatchObject({ expiresAt: 1_000_000 + 3_600_000 });
		const longer = await createAsset(worker, { path: "exports/inst-1/b.zip", expiresIn: 99_999 });
		expect(await longer.json()).toMatchObject({ expiresAt: 1_000_000 + 3_600_000 });
		const shorter = await createAsset(worker, { path: "exports/inst-1/c.zip", expiresIn: 60 });
		expect(await shorter.json()).toMatchObject({ expiresAt: 1_000_000 + 60_000 });
		vi.useRealTimers();
	});

	it("applies the scope's maxFileLifetimeSeconds as default and ceiling, under a shorter token TTL", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const worker = exportsWorker({ maxFileLifetimeSeconds: 600 });
		const byDefault = await createAsset(worker, { path: "exports/a.zip" });
		expect(await byDefault.json()).toMatchObject({ expiresAt: 1_000_000 + 600_000 });
		const longer = await createAsset(worker, { path: "exports/b.zip", expiresIn: 3600 });
		expect(await longer.json()).toMatchObject({ expiresAt: 1_000_000 + 600_000 });
		const shorter = await createAsset(worker, { path: "exports/c.zip", expiresIn: 60 });
		expect(await shorter.json()).toMatchObject({ expiresAt: 1_000_000 + 60_000 });
		const tokenWorker = exportsWorker({ maxFileLifetimeSeconds: 600, uploadGrant: { ...GRANT, fileExpiresIn: 120 } });
		const underToken = await createAsset(tokenWorker, { path: "exports/inst-1/d.zip" });
		expect(await underToken.json()).toMatchObject({ expiresAt: 1_000_000 + 120_000 });
		vi.useRealTimers();
	});
});

describe("overwrite", () => {
	it("defaults to false: 409 at creation when the asset exists", async () => {
		const worker = exportsWorker();
		const { res } = await uploadAsset(worker, { path: "exports/a.zip" });
		expect(res.status).toBe(200);

		const again = await createAsset(worker, { path: "exports/a.zip" });
		expect(again.status).toBe(409);
		expect(await again.json()).toMatchObject({ code: "already_exists" });
		expect((await createAsset(worker, { path: "exports/a.zip", overwrite: true })).status).toBe(200);
	});

	it("the PUT is conditional: an asset written after the creation is not replaced", async () => {
		const worker = exportsWorker({ security: { encrypt: true } });
		const created = await createAsset(worker, { path: "exports/race.zip" });
		const { uploadUrl } = (await created.json()) as { uploadUrl: string };
		// Another upload won between the create and the PUT.
		await worker.mediaBucket.put("prefix-a/private/asset/exports/race.zip", new Uint8Array([1]));

		const raced = await worker.send(uploadUrl, {
			method: "PUT",
			body: BYTES,
			headers: { "Content-Type": "application/zip" },
		});

		expect(raced.status).toBe(409);
		expect(worker.mediaBucket.objects.get("prefix-a/private/asset/exports/race.zip")?.bytes).toEqual(
			new Uint8Array([1]),
		);
		// The L4 key created for the failed attempt isn't left orphaned.
		expect(worker.keysBucket.objects.size).toBe(0);
	});
});

describe("TTL", () => {
	it("stores expiresAt and answers 410 once it has passed", async () => {
		vi.useFakeTimers({ now: 5_000_000 });
		const worker = exportsWorker({ ownerAccess: true });
		const { key } = await uploadAsset(worker, { path: "exports/ttl.zip", expiresIn: 60 });
		expect(worker.mediaBucket.objects.get(`prefix-a/${key}`)?.customMetadata.expiresAt).toBe(String(5_060_000));

		const fresh = await worker.send(`/v1/media/${key}`, { method: "HEAD" });
		expect(fresh.status).toBe(200);
		expect(fresh.headers.get("x-devultur-expires-at")).toBe(String(5_060_000));

		vi.setSystemTime(5_060_001);
		const expired = await worker.send(`/v1/media/${key}`);
		expect(expired.status).toBe(410);
		expect(await expired.json()).toMatchObject({ code: "expired" });
		vi.useRealTimers();
	});

	it("rejects a non-integer or absurd expiresIn", async () => {
		const worker = exportsWorker();
		for (const expiresIn of [0, -5, 1.5, 10 ** 12, "60"]) {
			const res = await createAsset(worker, { path: "exports/x.zip", expiresIn });
			expect(res.status).toBe(400);
		}
	});
});

describe("private delivery gate", () => {
	it("an upload token never opens private files", async () => {
		const worker = exportsWorker();
		const { key } = await uploadAsset(worker, { path: "exports/p.zip" });
		const issued = await worker.postJson("/v1/token/upload", { prefix: "exports/" });
		const { token } = (await issued.json()) as { token: string };
		expect(await verifyViewerToken(token, "delivery-secret")).toMatchObject({ typ: "upload" });

		const res = await worker.send(`/v1/media/${key}`, { headers: { Authorization: `Bearer ${token}` } });
		expect(res.status).toBe(401);
	});
});

describe("single-use download links", () => {
	async function linkFor(worker: Worker, body: Record<string, unknown>) {
		const res = await worker.postJson("/v1/token/download", body);
		return { res, link: (await res.clone().json()) as { url: string; expiresAt: number; maxUses: number } };
	}

	it("streams the file on the first redemption and answers 410 on the second", async () => {
		const worker = exportsWorker();
		const { key } = await uploadAsset(worker, { path: "exports/once.zip" });
		const { res, link } = await linkFor(worker, { key });
		expect(res.status).toBe(200);
		expect(link.url).toMatch(/^http:\/\/worker\/v1\/download\/[A-Za-z0-9_-]{22}$/);
		const path = new URL(link.url).pathname;

		const first = await worker.send(path);
		expect(first.status).toBe(200);
		expect(first.headers.get("content-disposition")).toMatch(/^attachment/);
		expect(first.headers.get("cache-control")).toBe("private, no-store");
		expect(new Uint8Array(await first.arrayBuffer())).toEqual(BYTES);

		const second = await worker.send(path);
		expect(second.status).toBe(410);
		expect(await second.json()).toMatchObject({ code: "link_used" });
	});

	it("only one of two concurrent redemptions wins", async () => {
		const worker = exportsWorker();
		const { key } = await uploadAsset(worker, { path: "exports/race.zip" });
		const { link } = await linkFor(worker, { key });
		const path = new URL(link.url).pathname;

		const statuses = (await Promise.all([worker.send(path), worker.send(path)])).map((res) => res.status).sort();
		expect(statuses).toEqual([200, 410]);
	});

	it("honors Range on the redeeming response, and HEAD does not consume", async () => {
		const worker = exportsWorker();
		const { key } = await uploadAsset(worker, { path: "exports/range.zip" });
		const { link } = await linkFor(worker, { key, maxUses: 1 });
		const path = new URL(link.url).pathname;

		expect((await worker.send(path, { method: "HEAD" })).status).toBe(405);
		const partial = await worker.send(path, { headers: { Range: "bytes=0-2" } });
		expect(partial.status).toBe(206);
		expect(new TextDecoder().decode(await partial.arrayBuffer())).toBe("zip");
	});

	it("expires, 404s unknown ids and refuses missing or expired files", async () => {
		vi.useFakeTimers({ now: 9_000_000 });
		const worker = exportsWorker();
		const { key } = await uploadAsset(worker, { path: "exports/late.zip" });
		const { link } = await linkFor(worker, { key, expiresIn: 60, maxUses: 3 });

		vi.setSystemTime(9_060_001);
		const late = await worker.send(new URL(link.url).pathname);
		expect(late.status).toBe(410);
		expect(await late.json()).toMatchObject({ code: "link_expired" });
		expect((await worker.send("/v1/download/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
		expect((await linkFor(worker, { key: "private/asset/exports/missing.zip" })).res.status).toBe(404);
		vi.useRealTimers();
	});

	it("asks the beforeLinkRedeem hook first: a rejection is returned as-is and does not spend the use", async () => {
		let isBlocked = true;
		const seen: DownloadLinkInfo[] = [];
		const pluginHooks: PluginHooks = {
			issueCredential: [],
			beforeLinkRedeem: [
				async (_context, link) => {
					seen.push(link);
					return isBlocked ? Response.json({ code: "link_refused" }, { status: 403 }) : null;
				},
			],
		};
		const worker = exportsWorker({ pluginHooks, context: { owner: "a" } });
		const { key } = await uploadAsset(worker, { path: "exports/gated.zip" });
		const path = new URL((await linkFor(worker, { key })).link.url).pathname;

		const blocked = await worker.send(path);
		expect(blocked.status).toBe(403);
		expect(seen[0]).toEqual({ storagePrefix: "prefix-a/", key, context: { owner: "a" } });

		isBlocked = false;
		expect((await worker.send(path)).status).toBe(200);
		expect((await worker.send(path)).status).toBe(410);
		expect(seen).toHaveLength(2);
	});

	it("validates the request", async () => {
		const worker = exportsWorker();
		for (const body of [{ key: "asset/no-visibility.zip" }, { key: "private/a.zip", maxUses: 0 }]) {
			expect((await linkFor(worker, body)).res.status).toBe(400);
		}
	});
});

describe("delete covers asset paths", () => {
	it("DELETE removes the asset and its L4 key, not a lookalike sibling", async () => {
		const worker = exportsWorker({ security: { encrypt: true } });
		const { key } = await uploadAsset(worker, { path: "exports/del.zip" });
		await uploadAsset(worker, { path: "exports/del.zip2" });
		const keysOf = (objectKey: string) =>
			[...worker.keysBucket.objects.keys()].filter((stored) => stored.startsWith(`prefix-a/${objectKey}/`));
		expect(keysOf(key)).toHaveLength(1);

		const res = await worker.send(`/v1/media/${key}`, { method: "DELETE" });

		expect(res.status).toBe(204);
		expect(worker.mediaBucket.objects.has(`prefix-a/${key}`)).toBe(false);
		expect(keysOf(key)).toEqual([]);
		expect(keysOf("private/asset/exports/del.zip2")).toHaveLength(1);
	});
});
