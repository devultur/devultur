import { describe, expect, it, vi } from "vitest";
import type { UploadGrant } from "../export-types";
import { exportsWorker } from "../exports-test-harness";
import { withSignature } from "../test-fixtures";
import { loggedAudits } from "./audit-test-support";

// The lock is written with the bytes (single PUT and multipart create) and enforced on delete.
const BYTES = withSignature("application/pdf", "pdf bytes");
const COMPLIANCE = { retention: { mode: "compliance", until: "2999-01-01T00:00:00Z" } };

type Worker = ReturnType<typeof exportsWorker>;

async function upload(worker: Worker, body: Record<string, unknown>) {
	const created = await worker.postJson("/v1/upload", { filename: "doc.pdf", contentType: "application/pdf", ...body });
	const json = (await created.json()) as { key: string; uploadUrl: string; code?: string };
	if (created.status !== 200) return { status: created.status, ...json };
	const put = await worker.send(json.uploadUrl, {
		method: "PUT",
		body: BYTES,
		headers: { "Content-Type": "application/pdf" },
	});
	expect(put.status).toBe(200);
	return { status: 200, ...json };
}

const storedLock = (worker: Worker, key: string) =>
	worker.mediaBucket.objects.get(`prefix-a/${key}`)?.customMetadata.lock;

describe("lock at upload", () => {
	it("stores the request's lock in the object's metadata", async () => {
		const worker = exportsWorker();
		const { key } = await upload(worker, { lock: COMPLIANCE });
		expect(JSON.parse(storedLock(worker, key) ?? "")).toEqual({
			retention: { mode: "compliance", until: "2999-01-01T00:00:00Z", derivatives: "inherit" },
			hold: false,
		});
	});

	it("falls back to the config's default and stores nothing when unlocked", async () => {
		const locked = exportsWorker({ lock: { hold: true } });
		expect(storedLock(locked, (await upload(locked, {})).key)).toBe('{"hold":true}');
		const plain = exportsWorker();
		expect(storedLock(plain, (await upload(plain, {})).key)).toBeUndefined();
	});

	it("doesn't let plugin uploadMetadata forge a lock", async () => {
		const worker = exportsWorker({ uploadMetadata: { lock: '{"hold":false}', LOCK: "x", origin: "a" } });
		const { key } = await upload(worker, { hold: true });
		const metadata = worker.mediaBucket.objects.get(`prefix-a/${key}`)?.customMetadata;
		expect(metadata).toMatchObject({ origin: "a", lock: '{"hold":true}' });
		expect(metadata).not.toHaveProperty("LOCK");
	});

	it("writes the lock at multipart create", async () => {
		const worker = exportsWorker();
		const created = await worker.postJson("/v1/upload", {
			filename: "big.pdf",
			contentType: "application/pdf",
			hold: true,
		});
		const { key, uploadUrl } = (await created.json()) as { key: string; uploadUrl: string };
		const res = await worker.send(`${uploadUrl}&multipart=create`, {
			method: "POST",
			body: JSON.stringify({ size: 10 }),
		});
		const { uploadId } = (await res.json()) as { uploadId: string };
		// The metadata is fixed at create: completing the session (empty here) yields an object that already carries it.
		await worker.env.MEDIA_BUCKET.resumeMultipartUpload(`prefix-a/${key}`, uploadId).complete([]);
		expect(storedLock(worker, key)).toBe('{"hold":true}');
	});

	// Retention keeps the object; expiry ends access to it. Share for a minute, keep for centuries.
	it("accepts a lock that outlives the file's expiry", async () => {
		const worker = exportsWorker();
		const result = await upload(worker, { lock: COMPLIANCE, hold: true, expiresIn: 60 });
		expect(result.status).toBe(200);
		const stored = worker.mediaBucket.objects.get(`prefix-a/${result.key}`)?.customMetadata;
		expect(stored).toMatchObject({ expiresAt: expect.any(String), lock: expect.stringContaining("compliance") });
	});

	it("enforces an upload token's minimum lock", async () => {
		const grant: UploadGrant = {
			tokenId: "t",
			pathPrefix: "asset/exports/",
			visibility: "private",
			lock: { hold: true },
		};
		const worker = exportsWorker({ uploadGrant: grant });
		expect(await upload(worker, { path: "exports/a.pdf", hold: false })).toMatchObject({
			status: 403,
			code: "lock_below_minimum",
		});
		const { key } = await upload(worker, { path: "exports/b.pdf" });
		expect(storedLock(worker, key)).toBe('{"hold":true}');
	});
});

describe("audit of the lock set at upload", () => {
	it("records who uploaded it, from the POST's plugin context, even on the credential-less PUT", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const worker = exportsWorker({ context: { owner: "a" } });
		const { key } = await upload(worker, { lock: COMPLIANCE });
		await worker.settle();
		expect(loggedAudits(log)).toEqual([
			expect.objectContaining({ action: "set", keys: [key], before: null, actor: { owner: "a" }, outcome: "applied" }),
		]);
		const records = [...worker.mediaBucket.objects.keys()].filter((stored) =>
			stored.startsWith("prefix-a/__lock-audit/"),
		);
		expect(records).toHaveLength(1);
		log.mockRestore();
	});

	it("records nothing for an unlocked upload", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await upload(exportsWorker(), {});
		expect(loggedAudits(log)).toEqual([]);
		log.mockRestore();
	});
});

describe("overwrite of a locked object", () => {
	const GRANT: UploadGrant = { tokenId: "t", pathPrefix: "asset/docs/", visibility: "private" };

	it("refuses `overwrite: true` on a locked asset at POST, before any bytes", async () => {
		const worker = exportsWorker({ uploadGrant: GRANT });
		const { key } = await upload(worker, { path: "docs/a.pdf", lock: COMPLIANCE });
		const res = await worker.postJson("/v1/upload", {
			filename: "a.pdf",
			contentType: "application/pdf",
			path: "docs/a.pdf",
			overwrite: true,
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "retention_active", key });
	});

	it("refuses the PUT when the lock was set after the POST, and creates no encryption key", async () => {
		const worker = exportsWorker({ uploadGrant: GRANT, security: { encrypt: true } });
		const { key } = await upload(worker, { path: "docs/b.pdf" });
		const created = await worker.postJson("/v1/upload", {
			filename: "b.pdf",
			contentType: "application/pdf",
			path: "docs/b.pdf",
			overwrite: true,
		});
		const { uploadUrl } = (await created.json()) as { uploadUrl: string };
		const stored = worker.mediaBucket.objects.get(`prefix-a/${key}`);
		if (stored) stored.customMetadata.lock = JSON.stringify({ hold: true });
		const keyCount = worker.keysBucket.objects.size;

		const res = await worker.send(uploadUrl, {
			method: "PUT",
			body: BYTES,
			headers: { "Content-Type": "application/pdf" },
		});

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "retention_active", hold: true });
		expect(worker.keysBucket.objects.size).toBe(keyCount);
	});

	// The race the conditional put closes: the object changes between the guard's check and the write (here, a lock
	// lands in that window). R2 refuses the put; the Worker answers 409 `write_conflict` rather than retrying, and
	// deletes the encryption key it had created for the refused attempt. The client retries and gets the current answer.
	it("answers 409 write_conflict when the object changes between the check and the put", async () => {
		const worker = exportsWorker({ uploadGrant: GRANT, security: { encrypt: true } });
		const { key } = await upload(worker, { path: "docs/c.pdf" });
		const created = await worker.postJson("/v1/upload", {
			filename: "c.pdf",
			contentType: "application/pdf",
			path: "docs/c.pdf",
			overwrite: true,
		});
		const { uploadUrl } = (await created.json()) as { uploadUrl: string };
		const keysBefore = [...worker.keysBucket.objects.keys()];
		const bucket = worker.env.MEDIA_BUCKET as unknown as { put: (...args: unknown[]) => Promise<unknown> };
		const realPut = bucket.put;
		bucket.put = async (...args) => {
			bucket.put = realPut;
			await realPut(`prefix-a/${key}`, "locked meanwhile", { customMetadata: { lock: '{"hold":true}' } });
			return realPut(...args);
		};

		const res = await worker.send(uploadUrl, {
			method: "PUT",
			body: BYTES,
			headers: { "Content-Type": "application/pdf" },
		});

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "write_conflict", key });
		expect(worker.mediaBucket.objects.get(`prefix-a/${key}`)?.customMetadata.lock).toBe('{"hold":true}');
		expect([...worker.keysBucket.objects.keys()]).toEqual(keysBefore);
	});

	it("still overwrites an unlocked asset", async () => {
		const worker = exportsWorker({ uploadGrant: GRANT });
		await upload(worker, { path: "docs/d.pdf" });
		const again = await upload(worker, { path: "docs/d.pdf", overwrite: true });
		expect(again.status).toBe(200);
	});
});

describe("delete of a locked object", () => {
	it("answers 409 retention_active and keeps the object and its keys", async () => {
		const worker = exportsWorker({ security: { encrypt: true } });
		const { key } = await upload(worker, { lock: COMPLIANCE });
		const keyCount = worker.keysBucket.objects.size;
		expect(keyCount).toBeGreaterThan(0);

		const res = await worker.send(`/v1/media/${key}`, { method: "DELETE" });

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			error: `${key} is retained and can't be deleted`,
			code: "retention_active",
			key,
			mode: "compliance",
			until: "2999-01-01T00:00:00.000Z",
			hold: false,
		});
		expect(worker.mediaBucket.objects.has(`prefix-a/${key}`)).toBe(true);
		expect(worker.keysBucket.objects.size).toBe(keyCount);
	});

	it("reports a hold", async () => {
		const worker = exportsWorker();
		const { key } = await upload(worker, { hold: true });
		const res = await worker.send(`/v1/media/${key}`, { method: "DELETE" });
		const body = await res.json();
		expect(body).toMatchObject({ code: "retention_active", hold: true });
		expect(body).not.toHaveProperty("mode");
	});

	it("deletes once the retention has expired", async () => {
		const worker = exportsWorker();
		const { key } = await upload(worker, {
			lock: { retention: { mode: "compliance", until: "2001-01-01T00:00:00Z" } },
		});
		expect((await worker.send(`/v1/media/${key}`, { method: "DELETE" })).status).toBe(204);
	});

	describe("a video's derived files", () => {
		const RAW = "prefix-a/private/video/v1/raw/clip.mp4";
		const CAPTION = "private/video/v1/captions/en.vtt";

		function videoWith(derivatives: "inherit" | "original-only") {
			const worker = exportsWorker();
			const lock = JSON.stringify({ retention: { ...COMPLIANCE.retention, derivatives }, hold: false });
			worker.mediaBucket.objects.set(RAW, { bytes: BYTES, httpMetadata: {}, customMetadata: { lock } });
			worker.mediaBucket.objects.set(`prefix-a/${CAPTION}`, { bytes: BYTES, httpMetadata: {}, customMetadata: {} });
			return worker;
		}

		it("inherit: a caption can't be deleted while the raw is retained", async () => {
			const worker = videoWith("inherit");
			const res = await worker.send(`/v1/media/${CAPTION}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({ key: "private/video/v1/raw/clip.mp4" });
		});

		it("original-only: the caption is free, the raw and the folder aren't", async () => {
			const worker = videoWith("original-only");
			expect((await worker.send(`/v1/media/${CAPTION}`, { method: "DELETE" })).status).toBe(204);
			expect((await worker.send("/v1/media/videos/v1", { method: "DELETE" })).status).toBe(409);
			expect(worker.mediaBucket.objects.has(RAW)).toBe(true);
		});

		it("deletes the whole video once nothing is locked", async () => {
			const worker = exportsWorker();
			worker.mediaBucket.objects.set(RAW, { bytes: BYTES, httpMetadata: {}, customMetadata: {} });
			worker.mediaBucket.objects.set(`prefix-a/${CAPTION}`, { bytes: BYTES, httpMetadata: {}, customMetadata: {} });
			const res = await worker.send("/v1/media/videos/v1?visibility=private", { method: "DELETE" });
			expect(await res.json()).toEqual({ videoId: "v1", deletedCount: 2, deletedKeyCount: 0 });
		});
	});
});
