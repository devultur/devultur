import { afterEach, describe, expect, it, vi } from "vitest";
import {
	classifyUploadRequest,
	isWorkerUploadUrl,
	MULTIPART_THRESHOLD_BYTES,
	multipartAbortUrl,
	multipartCompleteUrl,
	multipartCreateUrl,
	multipartPartCount,
	multipartPartRange,
	multipartPartUrl,
	shouldUseMultipart,
	UploadRequestKind,
	uploadMultipart,
	uploadToCapabilityUrl,
} from "./multipart";

const UPLOAD_URL = "https://api.test/v1/upload/public/video/abc/raw/clip.mp4";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("multipart planning", () => {
	it("splits a size into fixed parts with a shorter last part", () => {
		expect(multipartPartCount(250, 100)).toBe(3);
		expect(multipartPartRange(1, 250, 100)).toEqual({ start: 0, end: 100 });
		expect(multipartPartRange(3, 250, 100)).toEqual({ start: 200, end: 250 });
	});

	it("never plans zero parts", () => {
		expect(multipartPartCount(0, 100)).toBe(1);
	});

	it("builds the part URL on the same capability URL", () => {
		expect(multipartPartUrl(UPLOAD_URL, "u1", 2)).toBe(`${UPLOAD_URL}?uploadId=u1&partNumber=2`);
	});

	it("keeps the query the worker put in the upload URL on every multipart call", () => {
		const withPendingId = `${UPLOAD_URL}?u=pendingIdpendingIdpend`;
		for (const url of [
			multipartCreateUrl(withPendingId),
			multipartPartUrl(withPendingId, "u1", 2),
			multipartCompleteUrl(withPendingId),
			multipartAbortUrl(withPendingId, "u1"),
		]) {
			expect(new URL(url).searchParams.get("u"), url).toBe("pendingIdpendingIdpend");
		}
	});
});

describe("shouldUseMultipart", () => {
	it("only splits large files sent to the worker", () => {
		expect(shouldUseMultipart(UPLOAD_URL, MULTIPART_THRESHOLD_BYTES + 1)).toBe(true);
		expect(shouldUseMultipart(UPLOAD_URL, MULTIPART_THRESHOLD_BYTES)).toBe(false);
	});

	it("keeps presigned R2 URLs on a single PUT", () => {
		const presigned = "https://acc.r2.cloudflarestorage.com/bucket/v1/upload/x?X-Amz-Signature=abc";
		expect(isWorkerUploadUrl(presigned)).toBe(false);
		expect(shouldUseMultipart(presigned, MULTIPART_THRESHOLD_BYTES * 2)).toBe(false);
	});
});

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("uploadMultipart", () => {
	it("creates, uploads every part and completes with sorted etags", async () => {
		const calls: Array<{ method: string; url: string; body?: unknown }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
				calls.push({ method: init?.method ?? "GET", url, body });
				if (url.includes("multipart=create")) return json(200, { uploadId: "u1", partSize: 4, partCount: 3 });
				if (url.includes("multipart=complete")) return json(200, { key: "k", size: 10 });
				return json(500, {});
			}),
		);
		const uploadedParts: number[] = [];
		const progress: number[] = [];

		const result = await uploadMultipart(UPLOAD_URL, new Blob([new Uint8Array(10)]), {
			onProgress: (percent) => progress.push(percent),
			uploadPart: async (url, part, options) => {
				const partNumber = Number(new URL(url).searchParams.get("partNumber"));
				uploadedParts.push(part.size);
				options.onProgress(part.size);
				return { partNumber, etag: `e${partNumber}` };
			},
		});

		expect(result).toEqual({ key: "k", size: 10 });
		expect(uploadedParts.sort()).toEqual([2, 4, 4]);
		const complete = calls.find((call) => call.url.includes("multipart=complete"));
		expect(complete?.body).toEqual({
			uploadId: "u1",
			parts: [
				{ partNumber: 1, etag: "e1" },
				{ partNumber: 2, etag: "e2" },
				{ partNumber: 3, etag: "e3" },
			],
		});
		expect(progress.at(-1)).toBe(100);
	});

	it("aborts the multipart upload when a part fails", async () => {
		const methods: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				methods.push(`${init?.method} ${new URL(url).search}`);
				if (url.includes("multipart=create")) return json(200, { uploadId: "u1", partSize: 4, partCount: 2 });
				return json(200, {});
			}),
		);

		await expect(
			uploadMultipart(UPLOAD_URL, new Blob([new Uint8Array(8)]), {
				uploadPart: async () => {
					throw new Error("network down");
				},
			}),
		).rejects.toThrow("network down");
		expect(methods).toContain("DELETE ?uploadId=u1");
	});

	it("surfaces the worker's structured rejection from create", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json(413, { error: "too big", code: "file_too_large", limit: 5 })),
		);
		await expect(uploadMultipart(UPLOAD_URL, new Blob([new Uint8Array(8)]))).rejects.toMatchObject({
			status: 413,
			code: "file_too_large",
		});
	});
});

describe("uploadToCapabilityUrl", () => {
	it("uses a single PUT for small files", async () => {
		const fetchMock = vi.fn(async () => json(200, { key: "k", size: 2 }));
		vi.stubGlobal("fetch", fetchMock);
		await uploadToCapabilityUrl(UPLOAD_URL, new Blob(["hi"], { type: "image/png" }));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]).toEqual([UPLOAD_URL, expect.objectContaining({ method: "PUT" })]);
	});
});

describe("classifyUploadRequest", () => {
	const kindOf = (method: string, query: string) => classifyUploadRequest(method, new URLSearchParams(query));

	it("treats a plain PUT as the single upload and a complete part as a part", () => {
		expect(kindOf("PUT", "")).toBe(UploadRequestKind.SINGLE);
		expect(kindOf("PUT", "uploadId=u&partNumber=1")).toBe(UploadRequestKind.MULTIPART_PART);
	});

	// An empty `?uploadId=` was a "part" for one classifier and a "single PUT" for another: it wrote without the single-PUT checks.
	it("never downgrades incomplete multipart params to a single PUT", () => {
		expect(kindOf("PUT", "uploadId=")).toBe(UploadRequestKind.INVALID);
		expect(kindOf("PUT", "uploadId=u")).toBe(UploadRequestKind.INVALID);
		expect(kindOf("PUT", "partNumber=1")).toBe(UploadRequestKind.INVALID);
		expect(kindOf("DELETE", "uploadId=")).toBe(UploadRequestKind.INVALID);
	});

	it("routes POST actions and ignores a POST without one", () => {
		expect(kindOf("POST", "multipart=create")).toBe(UploadRequestKind.MULTIPART_CREATE);
		expect(kindOf("POST", "multipart=complete")).toBe(UploadRequestKind.MULTIPART_COMPLETE);
		expect(kindOf("POST", "multipart=other")).toBe(UploadRequestKind.INVALID);
		expect(kindOf("POST", "")).toBeNull();
	});
});
