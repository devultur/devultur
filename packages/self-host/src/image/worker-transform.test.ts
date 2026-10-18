// The media route with the Worker path (default) end to end in Node, with the SAME `.wasm` files.
import { decodeEncryptionMeta, decryptChunk, importEncryptionKey } from "@devultur/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signViewerToken } from "../helpers";
import { ObjectMeta } from "../routes/upload-integrity";
import {
	DELIVERY_SECRET,
	type MemoryBucket,
	mediaApp,
	memoryBucket,
	putEncrypted,
	sampleJpeg,
	servedSize,
	viewerToken,
} from "./test-support";

vi.mock("./wasm-modules", async () => (await import("./test-support")).diskWasmModules());

const ORIGINAL = "public/image/a/foto.jpg";
const PRIVATE_ORIGINAL = "private/image/a/foto.jpg";

let jpeg96x64: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
	jpeg96x64 = await sampleJpeg(96, 64);
});

afterEach(() => vi.restoreAllMocks());

function stubCloudflare(body = "cf") {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body, { status: 200 }));
}

async function publicOriginal(bytes = jpeg96x64): Promise<MemoryBucket> {
	const bucket = memoryBucket();
	await bucket.put(ORIGINAL, bytes, { httpMetadata: { contentType: "image/jpeg" } });
	return bucket;
}

describe("worker transforms (default path)", () => {
	it("generates a variant in the Worker without any IMAGE_TRANSFORMS config and reuses it", async () => {
		const bucket = await publicOriginal();
		const cloudflare = stubCloudflare();
		const request = mediaApp({ MEDIA_BUCKET: bucket });

		const first = await request(`/v1/media/${ORIGINAL}?w=48&format=webp`);
		expect(first.status).toBe(200);
		expect(first.headers.get("Content-Type")).toBe("image/webp");
		const variantKey = `${ORIGINAL}/__variants/w48_h_fit-_q.webp`;
		expect(bucket.objects.get(variantKey)?.customMetadata.derivedFrom).toBe("variant");
		const body = new Uint8Array(await first.arrayBuffer());
		expect(String.fromCharCode(...body.subarray(8, 12))).toBe("WEBP");

		const putSpy = vi.spyOn(bucket, "put");
		const second = await request(`/v1/media/${ORIGINAL}?width=48&format=webp`, { headers: { Range: "bytes=0-3" } });
		expect(second.status).toBe(206);
		expect(putSpy).not.toHaveBeenCalled();
		expect(cloudflare).not.toHaveBeenCalled();
	});

	it("negotiates format=auto from Accept and answers with Vary: Accept", async () => {
		const bucket = await publicOriginal();
		const request = mediaApp({ MEDIA_BUCKET: bucket });

		const avif = await request(`/v1/media/${ORIGINAL}?w=48&format=auto`, {
			headers: { Accept: "image/avif,image/webp,*/*" },
		});
		expect(avif.headers.get("Content-Type")).toBe("image/avif");
		expect(avif.headers.get("Vary")).toBe("Accept");

		const legacy = await request(`/v1/media/${ORIGINAL}?w=48&format=auto`, { headers: { Accept: "image/*" } });
		expect(legacy.headers.get("Content-Type")).toBe("image/jpeg");
		expect(legacy.headers.get("Vary")).toBe("Accept");
		expect(bucket.objects.has(`${ORIGINAL}/__variants/w48_h_fit-_q.avif`)).toBe(true);
		expect(bucket.objects.has(`${ORIGINAL}/__variants/w48_h_fit-_q.baseline`)).toBe(true);
	});

	it("does not send Vary when the format is explicit", async () => {
		const request = mediaApp({ MEDIA_BUCKET: await publicOriginal() });
		const response = await request(`/v1/media/${ORIGINAL}?w=48&format=jpeg`);
		expect(response.headers.get("Vary")).toBeNull();
	});

	it("implements fit=fill as a stretch to the exact box", async () => {
		const request = mediaApp({ MEDIA_BUCKET: await publicOriginal() });
		const response = await request(`/v1/media/${ORIGINAL}?w=40&h=40&fit=fill&format=jpeg`);
		expect(await servedSize(response)).toEqual({ width: 40, height: 40 });
	});

	it("keeps the aspect ratio with the default scale-down", async () => {
		const request = mediaApp({ MEDIA_BUCKET: await publicOriginal() });
		const response = await request(`/v1/media/${ORIGINAL}?w=40&h=40&format=jpeg`);
		expect(await servedSize(response)).toEqual({ width: 40, height: 27 });
	});

	it("keeps L4: an encrypted original yields an encrypted variant with its own key", async () => {
		const bucket = memoryBucket();
		const keys = memoryBucket();
		await putEncrypted(bucket, keys, PRIVATE_ORIGINAL, jpeg96x64, "image/jpeg");
		const request = mediaApp({ MEDIA_BUCKET: bucket, KEYS_BUCKET: keys });

		const response = await request(`/v1/media/${PRIVATE_ORIGINAL}?w=48&format=jpeg&token=${await viewerToken()}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toContain("private");
		const served = new Uint8Array(await response.arrayBuffer());
		expect([served[0], served[1]]).toEqual([0xff, 0xd8]);

		const variantKey = `${PRIVATE_ORIGINAL}/__variants/w48_h_fit-_q.jpeg`;
		const variant = bucket.objects.get(variantKey);
		const enc = decodeEncryptionMeta(variant?.customMetadata.enc);
		expect(enc).not.toBeNull();
		expect([variant?.body[0], variant?.body[1]]).not.toEqual([0xff, 0xd8]);
		const variantKeyBytes = keys.objects.get(`${variantKey}/${enc?.keyId}`);
		const decrypted = await decryptChunk(
			variant?.body ?? new Uint8Array(),
			await importEncryptionKey(variantKeyBytes?.body.buffer ?? new ArrayBuffer(0)),
			enc?.iv ?? new Uint8Array(),
			0,
		);
		expect(decrypted).toEqual(served);
	});

	it("never serves a variant by its own key", async () => {
		const bucket = await publicOriginal();
		const request = mediaApp({ MEDIA_BUCKET: bucket });
		await request(`/v1/media/${ORIGINAL}?w=48&format=webp`);
		const direct = await request(`/v1/media/${ORIGINAL}/__variants/w48_h_fit-_q.webp`);
		expect(direct.status).toBe(404);
	});
});

describe("worker transforms over private exports", () => {
	const PRIVATE_ASSET = "private/asset/exports/inst-1/foto.jpg";

	it("transforms an encrypted private asset like any other original", async () => {
		const bucket = memoryBucket();
		const keys = memoryBucket();
		await putEncrypted(bucket, keys, PRIVATE_ASSET, jpeg96x64, "image/jpeg");
		const request = mediaApp({ MEDIA_BUCKET: bucket, KEYS_BUCKET: keys });

		const response = await request(`/v1/media/${PRIVATE_ASSET}?w=48&format=jpeg&token=${await viewerToken()}`);
		expect(response.status).toBe(200);
		expect(await servedSize(response)).toEqual({ width: 48, height: 32 });
		expect(bucket.objects.has(`${PRIVATE_ASSET}/__variants/w48_h_fit-_q.jpeg`)).toBe(true);
	});

	it("answers 410 for an expired original without transforming it", async () => {
		const bucket = memoryBucket();
		await bucket.put(ORIGINAL, jpeg96x64, {
			httpMetadata: { contentType: "image/jpeg" },
			customMetadata: { [ObjectMeta.EXPIRES_AT]: String(Date.now() - 1000) },
		});
		const cloudflare = stubCloudflare();
		const request = mediaApp({ MEDIA_BUCKET: bucket });

		const response = await request(`/v1/media/${ORIGINAL}?w=48&format=webp`);
		expect(response.status).toBe(410);
		expect([...bucket.objects.keys()]).toEqual([ORIGINAL]);
		expect(cloudflare).not.toHaveBeenCalled();
	});

	it("does not serve an existing variant of an expired original", async () => {
		const bucket = await publicOriginal();
		const request = mediaApp({ MEDIA_BUCKET: bucket });
		await request(`/v1/media/${ORIGINAL}?w=48&format=webp`);
		const stored = bucket.objects.get(ORIGINAL);
		if (stored) stored.customMetadata = { [ObjectMeta.EXPIRES_AT]: String(Date.now() - 1000) };

		const response = await request(`/v1/media/${ORIGINAL}?w=48&format=webp`);
		expect(response.status).toBe(410);
	});

	it("refuses an upload token as the credential of a private transform", async () => {
		const bucket = memoryBucket();
		await bucket.put(PRIVATE_ORIGINAL, jpeg96x64, { httpMetadata: { contentType: "image/jpeg" } });
		const uploadToken = await signViewerToken(
			{ sub: "u", typ: "upload", exp: Math.floor(Date.now() / 1000) + 60 },
			DELIVERY_SECRET,
		);
		const request = mediaApp({ MEDIA_BUCKET: bucket });

		const response = await request(`/v1/media/${PRIVATE_ORIGINAL}?w=48&format=jpeg&token=${uploadToken}`);
		expect(response.status).toBe(401);
		expect(bucket.objects.size).toBe(1);
	});
});

describe("fallback to Cloudflare Images", () => {
	it("falls back for that request and logs when the codec fails", async () => {
		// SOI + SOF0 of 96×64 with a component declaring 0×0 sampling: passes the header guard but the decoder rejects it.
		const corrupt = new Uint8Array([
			0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x40, 0x00, 0x60, 0x01, 0x01, 0x00, 0x00, 0xff, 0xd9,
		]);
		const bucket = await publicOriginal(corrupt);
		const cloudflare = stubCloudflare();
		const logged = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await mediaApp({ MEDIA_BUCKET: bucket })(`/v1/media/${ORIGINAL}?w=48&format=webp`);
		expect(await response.text()).toBe("cf");
		expect(cloudflare).toHaveBeenCalledOnce();
		expect(logged.mock.calls.flat().join(" ")).toMatch(/fallback to cloudflare: error:/);
		expect([...bucket.objects.keys()]).toEqual([ORIGINAL]);
	});

	it("sends GIFs to Cloudflare without touching R2 variants", async () => {
		const bucket = memoryBucket();
		await bucket.put("public/image/a/anim.gif", new Uint8Array([0x47, 0x49, 0x46]), {
			httpMetadata: { contentType: "image/gif" },
		});
		const cloudflare = stubCloudflare();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const response = await mediaApp({ MEDIA_BUCKET: bucket })("/v1/media/public/image/a/anim.gif?w=48");
		expect(await response.text()).toBe("cf");
		expect(cloudflare).toHaveBeenCalledOnce();
		expect(bucket.objects.size).toBe(1);
	});

	it("honors the IMAGE_TRANSFORMS=cloudflare kill switch", async () => {
		const bucket = await publicOriginal();
		const cloudflare = stubCloudflare();
		const request = mediaApp({ MEDIA_BUCKET: bucket, IMAGE_TRANSFORMS: "cloudflare" });
		const response = await request(`/v1/media/${ORIGINAL}?w=48`);
		expect(await response.text()).toBe("cf");
		expect(cloudflare).toHaveBeenCalledOnce();
		expect(bucket.objects.size).toBe(1);
	});
});
