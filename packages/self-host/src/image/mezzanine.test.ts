// Originals above the guard: Cloudflare generates ONE master ≤ the cap and variants come from it in the Worker.
import { decodeEncryptionMeta } from "@devultur/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canServeFromMezzanine, mezzanineLongSide } from "./mezzanine";
import { mediaApp, memoryBucket, putEncrypted, sampleJpeg, servedSize, viewerToken } from "./test-support";

vi.mock("./wasm-modules", async () => (await import("./test-support")).diskWasmModules());

const ORIGINAL = "public/image/a/big.jpg";
const MEZZANINE = `${ORIGINAL}/__variants/mezzanine.jpeg`;
// 96×64 = 0.006 MP → with a cap of 0.004 MP the original is "large"; the 72×48 master (0.0035 MP) fits.
const TINY_BUDGET = { IMAGE_TRANSFORMS_MAX_MEGAPIXELS: "0.004" };

let original: Uint8Array<ArrayBuffer>;
let master: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
	original = await sampleJpeg(96, 64);
	master = await sampleJpeg(72, 48);
});

afterEach(() => vi.restoreAllMocks());

function stubMasterFromCloudflare(body: Uint8Array = master, contentType = "image/jpeg") {
	vi.spyOn(console, "log").mockImplementation(() => {});
	return vi.spyOn(globalThis, "fetch").mockImplementation(
		async () =>
			new Response(body.slice(), {
				headers: { "content-type": contentType, "content-length": String(body.byteLength) },
			}),
	);
}

async function largeOriginal() {
	const bucket = memoryBucket();
	await bucket.put(ORIGINAL, original, { httpMetadata: { contentType: "image/jpeg" } });
	return bucket;
}

describe("mezzanine geometry", () => {
	it("sizes the master to the megapixel budget on its long side", () => {
		const longSide = mezzanineLongSide({ width: 4032, height: 3024 }, 4);
		expect(longSide).toBe(2286);
		expect((longSide * Math.round((longSide * 3024) / 4032)) / 1_000_000).toBeLessThanOrEqual(4);
	});

	it("serves downscales from the master but not what would need the original's pixels", () => {
		const phone = { width: 4032, height: 3024 };
		const masterSize = { width: 2286, height: 1715 };
		expect(canServeFromMezzanine(phone, masterSize, { width: 800 })).toBe(true);
		expect(canServeFromMezzanine(phone, masterSize, { width: 400, height: 400, fit: "cover" })).toBe(true);
		expect(canServeFromMezzanine(phone, masterSize, { width: 3000 })).toBe(false);
		expect(canServeFromMezzanine(phone, masterSize, { format: "webp" })).toBe(false);
	});

	it("matches a portrait master against a landscape header (EXIF rotation)", () => {
		expect(canServeFromMezzanine({ width: 4032, height: 3024 }, { width: 1715, height: 2286 }, { width: 600 })).toBe(
			true,
		);
	});
});

describe("mezzanine flow", () => {
	it("asks Cloudflare once for the master, stores it and builds every variant from it", async () => {
		const bucket = await largeOriginal();
		const cloudflare = stubMasterFromCloudflare();
		const request = mediaApp({ MEDIA_BUCKET: bucket, ...TINY_BUDGET });

		const first = await request(`/v1/media/${ORIGINAL}?w=40&format=jpeg`);
		expect(first.status).toBe(200);
		expect(await servedSize(first)).toEqual({ width: 40, height: 27 });
		expect(cloudflare).toHaveBeenCalledOnce();
		const [url, init] = cloudflare.mock.calls[0];
		expect(url).toBe(`https://media.test/v1/media/${ORIGINAL}`);
		expect((init as RequestInit & { cf: { image: unknown } }).cf.image).toMatchObject({
			width: 76,
			height: 76,
			fit: "scale-down",
			format: "jpeg",
		});
		expect(bucket.objects.get(MEZZANINE)?.customMetadata.derivedFrom).toBe("mezzanine");

		const second = await request(`/v1/media/${ORIGINAL}?w=30&format=webp`);
		expect(second.headers.get("Content-Type")).toBe("image/webp");
		expect(cloudflare).toHaveBeenCalledOnce();
		expect(bucket.objects.has(`${ORIGINAL}/__variants/w30_h_fit-_q.webp`)).toBe(true);
	});

	it("shares one master generation between concurrent requests of an isolate", async () => {
		const bucket = await largeOriginal();
		const cloudflare = stubMasterFromCloudflare();
		const request = mediaApp({ MEDIA_BUCKET: bucket, ...TINY_BUDGET });

		const responses = await Promise.all([
			request(`/v1/media/${ORIGINAL}?w=40&format=jpeg`),
			request(`/v1/media/${ORIGINAL}?w=20&format=jpeg`),
		]);
		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		expect(cloudflare).toHaveBeenCalledOnce();
	});

	it("stores the master encrypted with its own key when the original is private", async () => {
		const bucket = memoryBucket();
		const keys = memoryBucket();
		const privateOriginal = "private/image/a/big.jpg";
		await putEncrypted(bucket, keys, privateOriginal, original, "image/jpeg");
		stubMasterFromCloudflare();
		const request = mediaApp({ MEDIA_BUCKET: bucket, KEYS_BUCKET: keys, ...TINY_BUDGET });

		const response = await request(`/v1/media/${privateOriginal}?w=40&format=jpeg&token=${await viewerToken()}`);
		expect(await servedSize(response)).toEqual({ width: 40, height: 27 });
		const stored = bucket.objects.get(`${privateOriginal}/__variants/mezzanine.jpeg`);
		const enc = decodeEncryptionMeta(stored?.customMetadata.enc);
		expect(enc).not.toBeNull();
		expect([stored?.body[0], stored?.body[1]]).not.toEqual([0xff, 0xd8]);
		expect(keys.objects.has(`${privateOriginal}/__variants/mezzanine.jpeg/${enc?.keyId}`)).toBe(true);
	});

	it("never stores a master Cloudflare did not actually transform", async () => {
		const bucket = await largeOriginal();
		// Cloudflare returning the original untouched: over budget → nothing is stored, the request goes to CF.
		const cloudflare = stubMasterFromCloudflare(original);
		const response = await mediaApp({ MEDIA_BUCKET: bucket, ...TINY_BUDGET })(`/v1/media/${ORIGINAL}?w=40`);
		expect(response.status).toBe(200);
		expect(cloudflare).toHaveBeenCalledTimes(2);
		expect([...bucket.objects.keys()]).toEqual([ORIGINAL]);
	});

	it("sends sizes the master cannot reproduce straight to Cloudflare", async () => {
		const bucket = await largeOriginal();
		const cloudflare = stubMasterFromCloudflare();
		const request = mediaApp({ MEDIA_BUCKET: bucket, ...TINY_BUDGET });
		await request(`/v1/media/${ORIGINAL}?w=90&format=jpeg`);
		expect(cloudflare).toHaveBeenCalledTimes(2);
		expect(bucket.objects.has(`${ORIGINAL}/__variants/w90_h_fit-_q.jpeg`)).toBe(false);
	});
});
