import { describe, expect, it, vi } from "vitest";

// Mock of the S3 storage → captures the options the router passes to createUploadUrl.
interface StorageUploadOptions {
	key: string;
	contentType: string;
	metadata?: Record<string, string>;
	storageClass?: string;
	contentDisposition?: string;
}
const createUploadUrlSpy = vi.fn(async (_options: StorageUploadOptions) => "https://signed.example/put");
vi.mock("./storage", () => ({
	createStorageClient: () => ({
		createUploadUrl: createUploadUrlSpy,
		createDownloadUrl: vi.fn(),
		deleteObject: vi.fn(),
		headObject: vi.fn(),
	}),
}));

const { image, video } = await import("./builders");
const { createMediaRouter } = await import("./router");

const storageConfig = {
	provider: "r2" as const,
	bucket: "b",
	accountId: "a",
	accessKeyId: "k",
	secretAccessKey: "s",
};

describe("router createUploadUrl (direct storage) — path parity", () => {
	it("sanitizes the filename in the KEY and keeps the original in Content-Disposition", async () => {
		createUploadUrlSpy.mockClear();
		const router = createMediaRouter({
			storage: storageConfig,
			image: image({ maxSize: "10MB", visibility: "public" }),
		});

		const result = await router.createUploadUrl({ filename: "Mi Vídeo #1.png", contentType: "image/png" });

		// the key uses the sanitized name (URL-safe), with no spaces or non-ASCII characters
		expect(result.key).toContain("Mi-Video-1.png");
		expect(result.key).not.toMatch(/\s/);
		expect(result.key.startsWith("public/image/")).toBe(true);

		// storage received the same key + a Content-Disposition inline with the ORIGINAL name
		const opts = createUploadUrlSpy.mock.calls[0][0];
		expect(opts.key).toBe(result.key);
		expect(opts.contentDisposition).toContain("filename*=UTF-8''Mi%20V%C3%ADdeo%20%231.png");
	});

	it("refuses a lock: a presigned PUT to the bucket can't enforce one", async () => {
		createUploadUrlSpy.mockClear();
		const router = createMediaRouter({ storage: storageConfig, image: image({ maxSize: "10MB" }) });
		await expect(router.createUploadUrl({ filename: "a.png", contentType: "image/png", hold: true })).rejects.toThrow(
			/needs a media worker/,
		);
		expect(createUploadUrlSpy).not.toHaveBeenCalled();
	});

	it("sends the video raw to Infrequent Access (S3 value STANDARD_IA)", async () => {
		createUploadUrlSpy.mockClear();
		const router = createMediaRouter({
			storage: storageConfig,
			video: video({ maxSize: "2GB" }),
		});

		await router.createUploadUrl({ filename: "clip.mp4", contentType: "video/mp4" });

		const opts = createUploadUrlSpy.mock.calls[0][0];
		expect(opts.storageClass).toBe("STANDARD_IA");
	});

	it("does NOT apply storageClass to images (only the video raw)", async () => {
		createUploadUrlSpy.mockClear();
		const router = createMediaRouter({
			storage: storageConfig,
			image: image({ maxSize: "10MB" }),
		});

		await router.createUploadUrl({ filename: "foto.jpg", contentType: "image/jpeg" });

		const opts = createUploadUrlSpy.mock.calls[0][0];
		expect(opts.storageClass).toBeUndefined();
	});
});
