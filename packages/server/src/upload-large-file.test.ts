import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadLargeFile } from "./upload-large-file";

const CONTENT = "institution export package";
const SHA256 = createHash("sha256").update(CONTENT).digest("hex");

let directory: string;
let filePath: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "devultur-upload-"));
	filePath = join(directory, "pkg.zip");
	await writeFile(filePath, CONTENT);
});

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await rm(directory, { recursive: true, force: true });
});

function stubWorker(storedSha256 = SHA256) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			if (url.endsWith("/v1/upload")) {
				return Response.json({
					key: "private/asset/exports/inst-1/pkg.zip",
					uploadUrl: "/v1/upload/k?u=pendingIdpendingIdpend",
				});
			}
			return Response.json({ key: "k", size: CONTENT.length, sha256: storedSha256, sha256Verified: true });
		}),
	);
	return calls;
}

describe("uploadLargeFile", () => {
	it("hashes the file, uploads it under the prefix with the token from the environment", async () => {
		vi.stubEnv("DEVULTUR_UPLOAD_TOKEN", "upload-token");
		const calls = stubWorker();

		const result = await uploadLargeFile(filePath, {
			prefix: "exports/inst-1",
			expiresIn: 604800,
			baseUrl: "https://api.test",
		});

		expect(result).toMatchObject({ key: "private/asset/exports/inst-1/pkg.zip", sha256: SHA256 });
		expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
			path: "exports/inst-1/pkg.zip",
			sha256: SHA256,
			expiresIn: 604800,
			size: CONTENT.length,
		});
		expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer upload-token");
		expect((calls[1].init?.headers as Record<string, string>)["x-devultur-sha256"]).toBe(SHA256);
		// The upload URL is opaque: its query (the worker's pending id) reaches the PUT untouched.
		expect(calls[1].url).toBe("https://api.test/v1/upload/k?u=pendingIdpendingIdpend");
	});

	it("fails loudly when the stored sha256 differs from the local one", async () => {
		stubWorker("0".repeat(64));
		await expect(
			uploadLargeFile(filePath, { prefix: "exports/", credential: "sk_x", baseUrl: "https://api.test" }),
		).rejects.toThrow(/sha256 mismatch/);
	});

	it("sends a precomputed sha256 and the Cache-Control", async () => {
		const declared = "b".repeat(64);
		const calls = stubWorker(declared);
		await uploadLargeFile(filePath, {
			prefix: "site/",
			credential: "sk_x",
			baseUrl: "https://api.test",
			sha256: declared,
			cacheControl: "immutable",
			overwrite: true,
		});
		expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
			sha256: declared,
			cacheControl: "immutable",
			overwrite: true,
		});
	});

	it("needs a credential", async () => {
		await expect(uploadLargeFile(filePath, { prefix: "exports/", baseUrl: "https://api.test" })).rejects.toThrow(
			/credential/,
		);
	});
});
