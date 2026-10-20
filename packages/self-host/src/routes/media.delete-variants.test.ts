// Deleting an original sweeps everything derived from it: variants, mezzanine, and their L4 keys (without touching neighbors).
import { encodeEncryptionMeta } from "@devultur/core";
import { describe, expect, it } from "vitest";
import { mediaApp, memoryBucket } from "../image/test-support";

const ORIGINAL = "private/image/a/foto.jpg";
const VARIANT = `${ORIGINAL}/__variants/w48_h_fit-_q.webp`;
const MEZZANINE = `${ORIGINAL}/__variants/mezzanine.jpeg`;
const NEIGHBOR = "private/image/a/foto.jpg-2";
const OTHER = "private/image/b/otra.jpg";

const bytes = new Uint8Array([1, 2, 3]);

async function seed() {
	const media = memoryBucket();
	const keys = memoryBucket();
	for (const key of [ORIGINAL, VARIANT, MEZZANINE, NEIGHBOR, OTHER]) {
		// Each object is encrypted with its own key `k1`, at `{key}/k1` in the keys bucket.
		const customMetadata = { enc: encodeEncryptionMeta(new Uint8Array(16), "k1") };
		await media.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" }, customMetadata });
		await keys.put(`${key}/k1`, bytes);
	}
	return { media, keys };
}

describe("DELETE /v1/media/:key", () => {
	it("removes the variants, the mezzanine and every L4 key under the original", async () => {
		const { media, keys } = await seed();
		const response = await mediaApp({ MEDIA_BUCKET: media, KEYS_BUCKET: keys })(`/v1/media/${ORIGINAL}`, {
			method: "DELETE",
		});
		expect(response.status).toBe(204);
		expect([...media.objects.keys()]).toEqual([NEIGHBOR, OTHER]);
		expect([...keys.objects.keys()]).toEqual([`${NEIGHBOR}/k1`, `${OTHER}/k1`]);
	});

	it("sweeps variants even under the cloudflare kill switch", async () => {
		const { media, keys } = await seed();
		const request = mediaApp({ MEDIA_BUCKET: media, KEYS_BUCKET: keys, IMAGE_TRANSFORMS: "cloudflare" });
		await request(`/v1/media/${ORIGINAL}`, { method: "DELETE" });
		expect(media.objects.has(VARIANT)).toBe(false);
		expect(media.objects.has(MEZZANINE)).toBe(false);
	});
});

describe("DELETE /v1/media/videos/:id", () => {
	it("takes the thumbnail variants and the video's L4 keys with it", async () => {
		const media = memoryBucket();
		const keys = memoryBucket();
		const thumbnail = "private/video/v1/thumbnails/thumbnail.jpg";
		const thumbnailVariant = `${thumbnail}/__variants/w320_h_fit-_q.webp`;
		for (const key of [thumbnail, thumbnailVariant, OTHER]) {
			await media.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
			await keys.put(`${key}/k1`, bytes);
		}
		await keys.put("private/video/v1/hls/k2", bytes);

		const request = mediaApp({ MEDIA_BUCKET: media, KEYS_BUCKET: keys });
		const response = await request("/v1/media/videos/v1?visibility=private", { method: "DELETE" });
		expect(await response.json()).toEqual({ videoId: "v1", deletedCount: 2, deletedKeyCount: 3 });
		expect([...media.objects.keys()]).toEqual([OTHER]);
		expect([...keys.objects.keys()]).toEqual([`${OTHER}/k1`]);
	});
});
