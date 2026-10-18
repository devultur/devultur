import { afterEach, describe, expect, it, vi } from "vitest";
import { assetKey, isAssetKey, MAX_ASSET_PATH_DEPTH, normalizeAssetPath, normalizeAssetPrefix } from "./assets";
import { normalizeSha256, reprDigest, sha256Hex } from "./integrity";
import { MULTIPART_PART_SIZE_BYTES } from "./multipart";
import { createWorkerClient } from "./worker-client";

const BASE = "https://api.test";
const API_KEY = "sk_abcdefghijklmnopqrstuvwxyz012345";

interface Call {
	url: string;
	init?: RequestInit;
}

function stubFetch(respond: (call: Call) => Response) {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const call = { url, init };
			calls.push(call);
			return respond(call);
		}),
	);
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("asset paths", () => {
	it("normalizes safe relative paths", () => {
		expect(normalizeAssetPath("/exports/inst-1/pkg.zip")).toBe("exports/inst-1/pkg.zip");
		expect(normalizeAssetPrefix("exports/inst-1")).toBe("exports/inst-1/");
		expect(normalizeAssetPrefix("/exports/inst-1/")).toBe("exports/inst-1/");
		expect(assetKey("private", "exports/a.zip")).toBe("private/asset/exports/a.zip");
	});

	it("rejects traversal, encoding, empty segments, namespace escapes and oversized paths", () => {
		const invalid = [
			"",
			"..",
			"a/../b",
			"a/./b",
			"a//b",
			"a/b/",
			"a%2Fb",
			"%2e%2e/b",
			"a b",
			"public/x",
			"private/asset/x",
			"asset/x",
			"a.jpg/__variants/w400.webp",
			"__variants/x",
			"a\\b",
			Array.from({ length: MAX_ASSET_PATH_DEPTH + 1 }, () => "d").join("/"),
			"x".repeat(513),
			42,
		];
		for (const raw of invalid) expect(normalizeAssetPath(raw)).toBeNull();
	});

	it("recognizes asset keys with or without visibility", () => {
		expect(isAssetKey("private/asset/a.zip")).toBe(true);
		expect(isAssetKey("asset/a.zip")).toBe(true);
		expect(isAssetKey("private/file/id/a.zip")).toBe(false);
		expect(isAssetKey("private/asset")).toBe(false);
	});
});

describe("integrity helpers", () => {
	it("normalizes sha256 hex and builds an RFC 9530 Repr-Digest", async () => {
		const empty = await sha256Hex(new Uint8Array());
		expect(empty).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		expect(reprDigest(empty)).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
		expect(normalizeSha256(empty.toUpperCase())).toBe(empty);
		expect(normalizeSha256("abc")).toBeNull();
	});
});

describe("client.uploads", () => {
	it("creates an upload token", async () => {
		const calls = stubFetch(() => Response.json({ token: "t", prefix: "exports/inst-1/" }));
		const token = await createWorkerClient(API_KEY, BASE).uploads.createToken({
			prefix: "exports/inst-1/",
			expiresIn: 3600,
			fileExpiresIn: 604800,
		});
		expect(token).toMatchObject({ token: "t" });
		expect(calls[0].url).toBe(`${BASE}/v1/token/upload`);
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			prefix: "exports/inst-1/",
			expiresIn: 3600,
			fileExpiresIn: 604800,
		});
	});

	it("uploads a small asset with one PUT carrying its sha256", async () => {
		const file = new Blob(["hello"], { type: "application/zip" });
		const sha256 = await sha256Hex(new TextEncoder().encode("hello"));
		const calls = stubFetch(({ url }) =>
			url.endsWith("/v1/upload")
				? Response.json({
						key: "private/asset/a/b.zip",
						uploadUrl: "/v1/upload/private/asset/a/b.zip?u=pendingIdpendingIdpend",
					})
				: Response.json({ key: "private/asset/a/b.zip", size: 5, sha256, sha256Verified: true }),
		);

		const result = await createWorkerClient("upload-token", BASE).uploads.uploadAsset(file, {
			path: "a/b.zip",
			sha256,
			expiresIn: 60,
		});

		expect(result).toMatchObject({ key: "private/asset/a/b.zip", sha256, sha256Verified: true });
		expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ path: "a/b.zip", size: 5, sha256, expiresIn: 60 });
		expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer upload-token");
		expect(calls[1].url).toBe(`${BASE}/v1/upload/private/asset/a/b.zip?u=pendingIdpendingIdpend`);
		expect((calls[1].init?.headers as Record<string, string>)["x-devultur-sha256"]).toBe(sha256);
		// La capability URL no lleva credencial.
		expect((calls[1].init?.headers as Record<string, string>).Authorization).toBeUndefined();
	});

	it("uploads a large asset in parts, declaring the file sha256 and checksumming every part", async () => {
		const size = MULTIPART_PART_SIZE_BYTES * 6 + 3;
		const file = new Blob([new Uint8Array(size)]);
		const calls = stubFetch(({ url, init }) => {
			if (url.endsWith("/v1/upload")) {
				return Response.json({
					key: "private/asset/big.bin",
					uploadUrl: "/v1/upload/private/asset/big.bin?u=pendingIdpendingIdpend",
				});
			}
			if (url.includes("multipart=create")) {
				return Response.json({ uploadId: "u1", partSize: MULTIPART_PART_SIZE_BYTES, partCount: 7 });
			}
			if (url.includes("multipart=complete")) {
				return Response.json({ key: "private/asset/big.bin", size, sha256: "a".repeat(64), sha256Verified: false });
			}
			const partNumber = Number(new URL(url).searchParams.get("partNumber"));
			expect(init?.method).toBe("PUT");
			return Response.json({ partNumber, etag: `e${partNumber}` });
		});

		const result = await createWorkerClient(API_KEY, BASE).uploads.uploadAsset(file, {
			path: "big.bin",
			sha256: "a".repeat(64),
		});

		expect(result).toMatchObject({ size, sha256Verified: false });
		const create = calls.find((call) => call.url.includes("multipart=create"));
		expect(JSON.parse(String(create?.init?.body))).toEqual({ size, sha256: "a".repeat(64) });
		const parts = calls.filter((call) => call.url.includes("partNumber="));
		expect(parts).toHaveLength(7);
		const zeroPart = await sha256Hex(new Uint8Array(MULTIPART_PART_SIZE_BYTES));
		const first = parts.find((call) => call.url.includes("partNumber=1&") || call.url.endsWith("partNumber=1"));
		expect((first?.init?.headers as Record<string, string>)["x-devultur-sha256"]).toBe(zeroPart);
	});
});

describe("client.files", () => {
	it("reads size, sha256, verification and expiry from a HEAD", async () => {
		const calls = stubFetch(
			() =>
				new Response(null, {
					status: 200,
					headers: {
						"content-length": "42",
						"content-type": "application/zip",
						etag: '"e"',
						"x-devultur-sha256": "b".repeat(64),
						"x-devultur-sha256-verified": "true",
						"x-devultur-expires-at": "1700000000000",
					},
				}),
		);
		const head = await createWorkerClient(API_KEY, BASE).files.head("private/asset/a.zip");
		expect(head).toEqual({
			key: "private/asset/a.zip",
			size: 42,
			contentType: "application/zip",
			etag: '"e"',
			sha256: "b".repeat(64),
			sha256Verified: true,
			expiresAt: 1700000000000,
		});
		expect(calls[0].init?.method).toBe("HEAD");
		expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
	});

	it("returns null for a missing file and throws on other errors", async () => {
		stubFetch(() => new Response(null, { status: 404 }));
		expect(await createWorkerClient(API_KEY, BASE).files.head("private/asset/x.zip")).toBeNull();
		stubFetch(() => new Response(null, { status: 403 }));
		await expect(createWorkerClient(API_KEY, BASE).files.head("private/asset/x.zip")).rejects.toMatchObject({
			status: 403,
		});
	});

	it("creates a download link, streams with Range and deletes", async () => {
		const calls = stubFetch(({ url }) =>
			url.endsWith("/v1/token/download")
				? Response.json({ url: "https://api.test/v1/download/abc", expiresAt: 1, maxUses: 1 })
				: new Response("bytes", { status: 206 }),
		);
		const client = createWorkerClient(API_KEY, BASE);
		const link = await client.files.createDownloadLink("private/asset/a.zip", { expiresIn: 600 });
		expect(link.url).toBe("https://api.test/v1/download/abc");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ key: "private/asset/a.zip", expiresIn: 600 });

		const stream = await client.files.stream("private/asset/a.zip", { range: "bytes=0-4" });
		expect(await stream.text()).toBe("bytes");
		expect((calls[1].init?.headers as Record<string, string>).Range).toBe("bytes=0-4");

		await client.files.delete("private/asset/a.zip");
		expect(calls[2]).toMatchObject({ url: `${BASE}/v1/media/private/asset/a.zip`, init: { method: "DELETE" } });
	});
});
