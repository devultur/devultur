import { reprDigest, sha256Hex } from "@devultur/core";
import { describe, expect, it } from "vitest";
import { exportsWorker } from "../exports-test-harness";
import { sniffableBytes, withSignature } from "../test-fixtures";

// Plaintext sha256: the single PUT computes it and verifies it against what was declared; multipart stores the
// DECLARED one (`sha256Verified: false`) and verifies each part against its own. GET/HEAD return it (`x-devultur-sha256` +
// `Repr-Digest`).

const PAYLOAD = withSignature("application/zip", "export package for institution 1");

async function createUpload(worker: ReturnType<typeof exportsWorker>, extra: Record<string, unknown> = {}) {
	const res = await worker.postJson("/v1/upload", {
		path: "exports/inst-1/pkg.zip",
		contentType: "application/zip",
		...extra,
	});
	return (await res.json()) as { key: string; uploadUrl: string };
}

const put = (worker: ReturnType<typeof exportsWorker>, uploadUrl: string, headers: Record<string, string> = {}) =>
	worker.send(uploadUrl, { method: "PUT", body: PAYLOAD, headers: { "Content-Type": "application/zip", ...headers } });

describe("single PUT sha256", () => {
	it("stores the plaintext sha256 and serves it on GET and HEAD", async () => {
		const worker = exportsWorker({ ownerAccess: true });
		const { key, uploadUrl } = await createUpload(worker);
		const expected = await sha256Hex(PAYLOAD);

		const res = await put(worker, uploadUrl);
		expect(await res.json()).toMatchObject({ key, size: PAYLOAD.byteLength, sha256: expected, sha256Verified: true });
		expect(worker.mediaBucket.objects.get(`prefix-a/${key}`)?.customMetadata).toMatchObject({
			sha256: expected,
			sha256Verified: "true",
		});

		const head = await worker.send(`/v1/media/${key}`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("x-devultur-sha256")).toBe(expected);
		expect(head.headers.get("x-devultur-sha256-verified")).toBe("true");
		expect(head.headers.get("repr-digest")).toBe(reprDigest(expected));
		expect(head.headers.get("content-length")).toBe(String(PAYLOAD.byteLength));
		const get = await worker.send(`/v1/media/${key}`);
		expect(new Uint8Array(await get.arrayBuffer())).toEqual(PAYLOAD);
	});

	it("hashes the plaintext even when the object is encrypted at rest", async () => {
		const worker = exportsWorker({ security: { encrypt: true }, ownerAccess: true });
		const { key, uploadUrl } = await createUpload(worker);
		await put(worker, uploadUrl);

		const stored = worker.mediaBucket.objects.get(`prefix-a/${key}`);
		expect(stored?.customMetadata.enc).toBeDefined();
		expect(stored?.bytes).not.toEqual(PAYLOAD);
		expect(stored?.customMetadata.sha256).toBe(await sha256Hex(PAYLOAD));
	});

	it("rejects with 400 when the bytes do not match the sha256 declared at creation", async () => {
		const worker = exportsWorker();
		const { key, uploadUrl } = await createUpload(worker, { sha256: "0".repeat(64) });

		const res = await put(worker, uploadUrl);

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "sha256_mismatch", actual: await sha256Hex(PAYLOAD) });
		expect(worker.mediaBucket.objects.has(`prefix-a/${key}`)).toBe(false);
	});

	it("rejects with 400 when the x-devultur-sha256 header does not match", async () => {
		const worker = exportsWorker();
		const { uploadUrl } = await createUpload(worker);
		const res = await put(worker, uploadUrl, { "x-devultur-sha256": "f".repeat(64) });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "sha256_mismatch" });
	});

	it("accepts a matching header and rejects a malformed sha256 at creation", async () => {
		const worker = exportsWorker();
		const { uploadUrl } = await createUpload(worker);
		const ok = await put(worker, uploadUrl, { "x-devultur-sha256": (await sha256Hex(PAYLOAD)).toUpperCase() });
		expect(ok.status).toBe(200);

		const invalid = await worker.postJson("/v1/upload", {
			path: "exports/x.zip",
			contentType: "application/zip",
			sha256: "nope",
		});
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toMatchObject({ code: "invalid_sha256" });
	});
});

describe("multipart sha256 (declared, per-part verified)", () => {
	const PART = 16 * 1024 * 1024;
	const SIZE = PART + 10;
	const file = new Uint8Array(SIZE).map((_, index) => index % 251);
	file.set(sniffableBytes("application/zip", 0));
	const partBytes = (partNumber: number) => file.slice((partNumber - 1) * PART, Math.min(partNumber * PART, SIZE));

	async function startMultipart(worker: ReturnType<typeof exportsWorker>, sha256?: string) {
		const { key, uploadUrl } = await createUpload(worker);
		const res = await worker.postJson(`${uploadUrl}&multipart=create`, { size: SIZE, ...(sha256 ? { sha256 } : {}) });
		const { uploadId } = (await res.json()) as { uploadId: string };
		const putPart = async (partNumber: number, headers: Record<string, string> = {}) =>
			worker.send(`${uploadUrl}&uploadId=${uploadId}&partNumber=${partNumber}`, {
				method: "PUT",
				body: partBytes(partNumber),
				headers,
			});
		return { key, uploadUrl, uploadId, putPart };
	}

	it("stores the declared whole-file sha256 as unverified and checks every part", async () => {
		const worker = exportsWorker({ ownerAccess: true });
		const declared = await sha256Hex(file);
		const { key, uploadUrl, uploadId, putPart } = await startMultipart(worker, declared);

		const parts = [];
		for (const partNumber of [1, 2]) {
			const res = await putPart(partNumber, { "x-devultur-sha256": await sha256Hex(partBytes(partNumber)) });
			expect(res.status).toBe(200);
			parts.push(await res.json());
		}
		const complete = await worker.postJson(`${uploadUrl}&multipart=complete`, { uploadId, parts });

		expect(await complete.json()).toMatchObject({ key, size: SIZE, sha256: declared, sha256Verified: false });
		const head = await worker.send(`/v1/media/${key}`, { method: "HEAD" });
		expect(head.headers.get("x-devultur-sha256")).toBe(declared);
		expect(head.headers.get("x-devultur-sha256-verified")).toBe("false");
	});

	it("requires a part checksum when the upload declares a sha256, and rejects a wrong one", async () => {
		const worker = exportsWorker();
		const { putPart } = await startMultipart(worker, "a".repeat(64));

		const missing = await putPart(1);
		expect(missing.status).toBe(400);
		expect(await missing.json()).toMatchObject({ code: "part_sha256_required" });

		const wrong = await putPart(1, { "x-devultur-sha256": "b".repeat(64) });
		expect(wrong.status).toBe(400);
		expect(await wrong.json()).toMatchObject({ code: "sha256_mismatch" });
	});

	it("keeps working without any sha256 (browser uploads)", async () => {
		const worker = exportsWorker();
		const { uploadUrl, uploadId, putPart } = await startMultipart(worker);
		const parts = [await (await putPart(1)).json(), await (await putPart(2)).json()];
		const complete = await worker.postJson(`${uploadUrl}&multipart=complete`, { uploadId, parts });
		expect(complete.status).toBe(200);
		expect(await complete.json()).not.toHaveProperty("sha256");
	});
});
