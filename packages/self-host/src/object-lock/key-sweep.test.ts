// Regression tests: sweeping an object's encryption keys never shreds the key of an upload still writing that object.
import { decodeEncryptionMeta } from "@devultur/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportsWorker } from "../exports-test-harness";
import { ENCRYPTION_KEY_MISSING_CODE } from "../keys-bucket";

afterEach(() => {
	vi.restoreAllMocks();
});

const PART_BYTES = 10;

function encryptedWorker() {
	vi.spyOn(console, "error").mockImplementation(() => {});
	const worker = exportsWorker({ security: { encrypt: true } });
	const post = async (overwrite: boolean) => {
		const created = await worker.postJson("/v1/upload", {
			contentType: "application/pdf",
			path: "report.pdf",
			overwrite,
		});
		return (await created.json()) as { key: string; uploadUrl: string };
	};
	const putPdf = (uploadUrl: string) =>
		worker.send(uploadUrl, { method: "PUT", body: "pdf", headers: { "Content-Type": "application/pdf" } });
	const ownKeys = (key: string) =>
		[...worker.keysBucket.objects.keys()].filter((stored) => stored.startsWith(`prefix-a/${key}/`));
	const storedKeyId = (key: string) =>
		decodeEncryptionMeta(worker.mediaBucket.objects.get(`prefix-a/${key}`)?.customMetadata.enc)?.keyId;

	/** A multipart over `uploadUrl`, created and its one part sent; `complete()` finishes it. */
	const startMultipart = async (uploadUrl: string) => {
		const created = await worker.send(`${uploadUrl}&multipart=create`, {
			method: "POST",
			body: JSON.stringify({ size: PART_BYTES }),
		});
		const { uploadId } = (await created.json()) as { uploadId: string };
		const part = await worker.send(`${uploadUrl}&uploadId=${uploadId}&partNumber=1`, {
			method: "PUT",
			body: new Uint8Array(PART_BYTES),
		});
		expect(part.status).toBe(200);
		const complete = () =>
			worker.send(`${uploadUrl}&multipart=complete`, {
				method: "POST",
				body: JSON.stringify({ uploadId, parts: [{ partNumber: 1, etag: "e" }] }),
			});
		return { uploadId, complete };
	};
	const deleteMedia = (key: string) => worker.send(`/v1/media/${key}`, { method: "DELETE" });
	return { worker, post, putPdf, ownKeys, storedKeyId, startMultipart, deleteMedia };
}

describe("a delete keeps the key of an upload in flight over the object", () => {
	it("a multipart overwrite created before the delete completes into a decryptable object", async () => {
		const { post, putPdf, ownKeys, storedKeyId, startMultipart, deleteMedia } = encryptedWorker();
		const { key, uploadUrl } = await post(false);
		expect((await putPdf(uploadUrl)).status).toBe(200);
		const oldKeyId = storedKeyId(key);

		const overwrite = await post(true);
		const multipart = await startMultipart(overwrite.uploadUrl);
		expect((await deleteMedia(key)).status).toBe(204);

		// Only the deleted version's key went; the in-flight upload's (newer) stayed.
		expect(ownKeys(key)).toHaveLength(1);
		expect(ownKeys(key)).not.toContain(`prefix-a/${key}/${oldKeyId}`);
		expect((await multipart.complete()).status).toBe(200);
		expect(ownKeys(key)).toEqual([`prefix-a/${key}/${storedKeyId(key)}`]);
	});

	it("a delete still sweeps keys older than the deleted version", async () => {
		const { worker, post, putPdf, ownKeys, deleteMedia } = encryptedWorker();
		const { key, uploadUrl } = await post(false);
		worker.keysBucket.objects.set(`prefix-a/${key}/orphan`, {
			bytes: new Uint8Array(1),
			httpMetadata: {},
			customMetadata: {},
			uploaded: new Date(0),
		});
		expect((await putPdf(uploadUrl)).status).toBe(200);
		expect((await deleteMedia(key)).status).toBe(204);
		expect(ownKeys(key)).toEqual([]);
	});
});

describe("an upload whose key was swept fails closed", () => {
	it("a multipart complete refuses, aborts the session and stores nothing", async () => {
		const { worker, post, ownKeys, startMultipart } = encryptedWorker();
		const { key, uploadUrl } = await post(false);
		const multipart = await startMultipart(uploadUrl);
		for (const stored of ownKeys(key)) worker.keysBucket.objects.delete(stored);

		const complete = await multipart.complete();

		expect(complete.status).toBe(500);
		expect(await complete.json()).toMatchObject({ code: ENCRYPTION_KEY_MISSING_CODE });
		expect(worker.mediaBucket.objects.has(`prefix-a/${key}`)).toBe(false);
		// The session is gone: a retry doesn't complete it either.
		expect((await multipart.complete()).status).toBe(404);
	});

	it("a single PUT whose key disappears before its put stores nothing", async () => {
		const { worker, post, putPdf } = encryptedWorker();
		const { key, uploadUrl } = await post(false);
		const keysPut = worker.keysBucket.put;
		worker.keysBucket.put = async (target, value, options) => {
			const stored = await keysPut(target, value, options);
			worker.keysBucket.objects.delete(target);
			return stored;
		};

		const put = await putPdf(uploadUrl);

		expect(put.status).toBe(500);
		expect(await put.json()).toMatchObject({ code: ENCRYPTION_KEY_MISSING_CODE });
		expect(worker.mediaBucket.objects.has(`prefix-a/${key}`)).toBe(false);
	});
});

describe("a repeated multipart complete keeps the key of the object it wrote", () => {
	it("a second complete that passed the session check doesn't delete the live key", async () => {
		const { worker, post, ownKeys, storedKeyId, startMultipart } = encryptedWorker();
		// `overwrite`: a create-only asset's second complete is refused (`409 already_exists`) before any key goes.
		const { key, uploadUrl } = await post(true);
		const multipart = await startMultipart(uploadUrl);
		// Both completes read the active session before either removed it.
		const sessions = new Map(worker.kv.entries);

		expect((await multipart.complete()).status).toBe(200);
		for (const [kvKey, value] of sessions) worker.kv.entries.set(kvKey, value);
		expect((await multipart.complete()).status).toBe(200);

		expect(ownKeys(key)).toEqual([`prefix-a/${key}/${storedKeyId(key)}`]);
	});
});
