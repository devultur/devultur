import { afterEach, describe, expect, it, vi } from "vitest";
import { HTML, JPEG, PDF, PNG, setup, storedContentType, withHead } from "./upload-content-check-harness";

const loggedMismatches = () =>
	vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line).replace("[content-sniff] ", "")));

afterEach(() => vi.restoreAllMocks());

describe("single PUT content verification (default: scriptable)", () => {
	it("stores a file whose bytes match its type, and logs nothing", async () => {
		const warn = vi.spyOn(console, "warn");
		const { createUpload, put, objects } = setup();
		const url = await createUpload("application/pdf", "report.pdf");

		expect((await put(url, "application/pdf", withHead(PDF, 64))).status).toBe(200);
		expect(storedContentType([...objects.values()][0])).toBe("application/pdf");
		expect(warn).not.toHaveBeenCalled();
	});

	it("rejects an HTML file declared as a PDF with 415, stores nothing, and logs it", async () => {
		vi.spyOn(console, "warn");
		const { createUpload, put, objects, kv } = setup();
		const url = await createUpload("application/pdf", "report.pdf");

		const res = await put(url, "application/pdf", withHead(HTML, HTML.length));

		expect(res.status).toBe(415);
		expect(await res.json()).toMatchObject({
			code: "content_type_mismatch",
			declared: "application/pdf",
			detected: "html",
		});
		expect(objects.size).toBe(0);
		// The pending stays: the client can retry with the right file.
		expect(kv.size).toBe(1);
		expect(loggedMismatches()).toEqual([
			{ declared: "application/pdf", detected: "html", key: expect.stringMatching(/report\.pdf$/), action: "rejected" },
		]);
	});

	it("stores any other mismatch with its declared type, and logs it", async () => {
		vi.spyOn(console, "warn");
		const { createUpload, put, objects } = setup();
		const url = await createUpload("image/png", "photo.png");

		expect((await put(url, "image/png", withHead(JPEG, 64))).status).toBe(200);
		expect(storedContentType([...objects.values()][0])).toBe("image/png");
		expect(loggedMismatches()).toMatchObject([{ declared: "image/png", detected: "jpeg", action: "accepted" }]);
	});

	it("checks before encrypting, and creates no encryption key", async () => {
		const { createUpload, put, objects, keys } = setup({ isEncrypted: true });
		const url = await createUpload("image/png", "photo.png", "private");

		expect((await put(url, "image/png", withHead(HTML, HTML.length))).status).toBe(415);
		expect(objects.size).toBe(0);
		expect(keys.size).toBe(0);
	});

	it("keeps a type outside the signature table as declared", async () => {
		const { createUpload, put, objects } = setup();
		const url = await createUpload("application/x-custom", "data.bin");

		expect((await put(url, "application/x-custom", withHead(HTML, HTML.length))).status).toBe(200);
		expect(storedContentType([...objects.values()][0])).toBe("application/x-custom");
	});
});

describe("single PUT content verification: opt-in modes", () => {
	it('rejects every mismatch with contentSniffing: "reject"', async () => {
		vi.spyOn(console, "warn");
		const { createUpload, put, objects } = setup({ contentSniffing: "reject" });
		const url = await createUpload("image/png", "photo.png");

		const res = await put(url, "image/png", withHead(JPEG, 64));

		expect(res.status).toBe(415);
		expect(await res.json()).toMatchObject({ declared: "image/png", detected: "jpeg" });
		expect(objects.size).toBe(0);
		expect(loggedMismatches()).toMatchObject([{ action: "rejected" }]);
	});

	it('stores a mismatch as application/octet-stream with contentSniffing: "octet-stream"', async () => {
		vi.spyOn(console, "warn");
		const { createUpload, put, objects } = setup({ contentSniffing: "octet-stream" });
		const url = await createUpload("image/png", "photo.png");

		expect((await put(url, "image/png", withHead(HTML, HTML.length))).status).toBe(200);
		expect(storedContentType([...objects.values()][0])).toBe("application/octet-stream");
		expect(loggedMismatches()).toMatchObject([{ action: "stored_as_octet_stream" }]);
	});

	it('skips the check with contentSniffing: "off"', async () => {
		const warn = vi.spyOn(console, "warn");
		const { createUpload, put, objects } = setup({ contentSniffing: "off" });
		const url = await createUpload("image/png", "photo.png");

		expect((await put(url, "image/png", withHead(HTML, HTML.length))).status).toBe(200);
		expect(storedContentType([...objects.values()][0])).toBe("image/png");
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("single PUT content verification: transcode outputs", () => {
	it("never checks an output with the runner's type for its folder", async () => {
		const { put, objects } = setup({ isAuthenticated: true, contentSniffing: "reject" });

		expect((await put("/v1/upload/public/video/vid1/thumbnails/poster.jpg", "image/jpeg", PNG.slice())).status).toBe(
			200,
		);
		expect((await put("/v1/upload/public/video/vid1/storyboard/sprites.vtt", "text/vtt", HTML.slice())).status).toBe(
			200,
		);
		expect(storedContentType(objects.get("public/video/vid1/thumbnails/poster.jpg"))).toBe("image/jpeg");
	});

	it("checks a derived path written with another type, and an authenticated write of an original", async () => {
		const { put } = setup({ isAuthenticated: true });

		const poster = await put("/v1/upload/public/video/vid1/thumbnails/poster.png", "image/png", HTML.slice());
		const mp4Folder = await put("/v1/upload/public/video/vid1/mp4/notes.txt", "text/plain", HTML.slice());
		const original = await put("/v1/upload/public/image/i1/photo.png", "image/png", HTML.slice());

		expect([poster.status, mp4Folder.status, original.status]).toEqual([415, 415, 415]);
	});
});
