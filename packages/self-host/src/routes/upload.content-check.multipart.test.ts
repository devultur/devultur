import { afterEach, describe, expect, it, vi } from "vitest";
import { HTML, MP4_HEAD, PART, setup, WEBM_HEAD, withHead } from "./upload-content-check-harness";

afterEach(() => vi.restoreAllMocks());

async function startUpload(harness: ReturnType<typeof setup>, visibility = "public") {
	const url = await harness.createUpload("video/mp4", "clip.mp4", visibility);
	const uploadId = await harness.createMultipart(url, PART + 100);
	return { url, uploadId };
}

describe("multipart content verification", () => {
	it("checks part 1 and lets the complete through when it names that part 1", async () => {
		const harness = setup();
		const { url, uploadId } = await startUpload(harness);

		expect((await harness.putPart(url, uploadId, 1, withHead(MP4_HEAD, PART))).status).toBe(200);
		expect((await harness.putPart(url, uploadId, 2, new Uint8Array(100))).status).toBe(200);
		expect((await harness.complete(url, uploadId, 2)).status).toBe(200);
		expect(harness.sessions.get(uploadId)?.isAborted).toBe(false);
	});

	it("aborts the upload on a scriptable part 1: R2 session, pending and encryption key", async () => {
		vi.spyOn(console, "warn");
		const harness = setup({ isEncrypted: true });
		const { url, uploadId } = await startUpload(harness, "private");
		expect(harness.keys.size).toBe(1);

		const res = await harness.putPart(url, uploadId, 1, withHead(HTML, PART));

		expect(res.status).toBe(415);
		expect(await res.json()).toMatchObject({ code: "content_type_mismatch", declared: "video/mp4", detected: "html" });
		expect(harness.sessions.get(uploadId)).toMatchObject({ isAborted: true });
		expect(harness.sessions.get(uploadId)?.etags.size).toBe(0);
		expect(harness.kv.size).toBe(0);
		expect(harness.keys.size).toBe(0);
		expect((await harness.putPart(url, uploadId, 2, new Uint8Array(100))).status).toBe(404);
		expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toMatch(/^\[content-sniff\] \{.*"action":"rejected"/);
	});

	it("accepts any other part-1 mismatch by default, and rejects it in reject mode", async () => {
		vi.spyOn(console, "warn");
		const lenient = setup();
		const accepted = await startUpload(lenient);
		expect((await lenient.putPart(accepted.url, accepted.uploadId, 1, withHead(WEBM_HEAD, PART))).status).toBe(200);
		expect((await lenient.putPart(accepted.url, accepted.uploadId, 2, new Uint8Array(100))).status).toBe(200);
		expect((await lenient.complete(accepted.url, accepted.uploadId, 2)).status).toBe(200);

		const strict = setup({ contentSniffing: "reject" });
		const rejected = await startUpload(strict);
		expect((await strict.putPart(rejected.url, rejected.uploadId, 1, withHead(WEBM_HEAD, PART))).status).toBe(415);
		expect(strict.sessions.get(rejected.uploadId)?.isAborted).toBe(true);
	});

	it("refuses the complete until part 1 has been checked, when parts arrive out of order", async () => {
		const harness = setup();
		const { url, uploadId } = await startUpload(harness);

		expect((await harness.putPart(url, uploadId, 2, new Uint8Array(100))).status).toBe(200);
		const early = await harness.complete(url, uploadId, 2, [
			{ partNumber: 1, etag: "etag-1-guessed" },
			{ partNumber: 2, etag: harness.sessions.get(uploadId)?.etags.get(2) ?? "" },
		]);
		expect(early.status).toBe(409);
		expect(await early.json()).toMatchObject({ code: "content_unverified" });

		expect((await harness.putPart(url, uploadId, 1, withHead(MP4_HEAD, PART))).status).toBe(200);
		expect((await harness.complete(url, uploadId, 2)).status).toBe(200);
	});

	it("checks a re-upload of part 1 too: scriptable bytes after a pass abort the upload", async () => {
		const harness = setup();
		const { url, uploadId } = await startUpload(harness);

		expect((await harness.putPart(url, uploadId, 1, withHead(MP4_HEAD, PART))).status).toBe(200);
		expect((await harness.putPart(url, uploadId, 1, withHead(HTML, PART))).status).toBe(415);
		expect(harness.sessions.get(uploadId)?.isAborted).toBe(true);
	});

	it("refuses a complete that names a part 1 other than the last one checked", async () => {
		const harness = setup();
		const { url, uploadId } = await startUpload(harness);
		await harness.putPart(url, uploadId, 1, withHead(MP4_HEAD, PART));
		const firstEtag = harness.sessions.get(uploadId)?.etags.get(1) ?? "";
		await harness.putPart(url, uploadId, 1, withHead(MP4_HEAD, PART));
		await harness.putPart(url, uploadId, 2, new Uint8Array(100));
		const secondPart = { partNumber: 2, etag: harness.sessions.get(uploadId)?.etags.get(2) ?? "" };

		const stale = await harness.complete(url, uploadId, 2, [{ partNumber: 1, etag: firstEtag }, secondPart]);

		expect(stale.status).toBe(409);
		expect((await harness.complete(url, uploadId, 2)).status).toBe(200);
	});

	it('still rejects a scriptable part 1 with contentSniffing: "octet-stream" (the type is fixed at create)', async () => {
		const harness = setup({ contentSniffing: "octet-stream" });
		const { url, uploadId } = await startUpload(harness);

		expect((await harness.putPart(url, uploadId, 1, withHead(HTML, PART))).status).toBe(415);
		expect(harness.sessions.get(uploadId)?.isAborted).toBe(true);
	});

	it('skips the check with contentSniffing: "off"', async () => {
		const harness = setup({ contentSniffing: "off" });
		const { url, uploadId } = await startUpload(harness);

		expect((await harness.putPart(url, uploadId, 2, new Uint8Array(100))).status).toBe(200);
		expect((await harness.putPart(url, uploadId, 1, withHead(HTML, PART))).status).toBe(200);
		expect((await harness.complete(url, uploadId, 2)).status).toBe(200);
	});

	it("never checks a transcode's large outputs", async () => {
		const harness = setup({ isAuthenticated: true, contentSniffing: "reject" });
		const url = "/v1/upload/public/video/vid1/mp4/720p.mp4";
		const uploadId = await harness.createMultipart(url, PART + 100, { contentType: "video/mp4" });

		expect(harness.sessions.get(uploadId)?.contentType).toBe("video/mp4");
		expect((await harness.putPart(url, uploadId, 1, withHead(HTML, PART))).status).toBe(200);
		expect((await harness.putPart(url, uploadId, 2, new Uint8Array(100))).status).toBe(200);
		expect((await harness.complete(url, uploadId, 2)).status).toBe(200);
	});

	it("checks a derived multipart declared with a type the runner doesn't use there", async () => {
		const harness = setup({ isAuthenticated: true });
		const url = "/v1/upload/public/video/vid1/thumbnails/huge.jpg";
		const uploadId = await harness.createMultipart(url, PART + 100, { contentType: "video/mp4" });

		expect((await harness.putPart(url, uploadId, 1, withHead(HTML, PART))).status).toBe(415);
	});
});
