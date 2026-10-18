// Fallback to Cloudflare Images: origin URL without token, subrequest's own authorization, `fit` and `format=auto`.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cloudflareImageOptions,
	cloudflareOutputFormat,
	imageOriginAuthorization,
	readImageOriginScope,
} from "./cloudflare";
import { DELIVERY_SECRET, mediaApp, memoryBucket, viewerToken } from "./test-support";

const PRIVATE_GIF = "private/image/a/anim.gif";
const ORIGIN_URL = new URL(`https://media.test/v1/media/${PRIVATE_GIF}`);
const VIA = "1.1 image-resizing";

afterEach(() => vi.restoreAllMocks());

async function privateGifBucket() {
	const bucket = memoryBucket();
	await bucket.put(PRIVATE_GIF, new Uint8Array([0x47, 0x49, 0x46, 0x38]), {
		httpMetadata: { contentType: "image/gif" },
	});
	return bucket;
}

function stubCloudflare() {
	vi.spyOn(console, "log").mockImplementation(() => {});
	return vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async () => new Response("cf", { headers: { "content-type": "image/webp" } }));
}

const originRequest = (url: URL, authorization: string) =>
	new Request(url, { headers: { via: VIA, Authorization: authorization } });

describe("origin URL and authorization", () => {
	it("asks Cloudflare for the original without the viewer token, with the same credential for every viewer", async () => {
		const cloudflare = stubCloudflare();
		const request = mediaApp({ MEDIA_BUCKET: await privateGifBucket() });

		for (const token of [await viewerToken(), await viewerToken()]) {
			const response = await request(`/v1/media/${PRIVATE_GIF}?w=48&token=${token}`);
			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toContain("private");
		}

		const [first, second] = cloudflare.mock.calls;
		expect(first[0]).toBe(ORIGIN_URL.toString());
		expect(second[0]).toBe(first[0]);
		const authorization = ((first[1] as RequestInit).headers as Record<string, string>).Authorization;
		expect(authorization).toBe(((second[1] as RequestInit).headers as Record<string, string>).Authorization);
		expect(authorization).toBe(await imageOriginAuthorization(DELIVERY_SECRET, { url: ORIGIN_URL, scope: "" }));
		expect((first[1] as RequestInit & { cf: { image: object } }).cf.image).toMatchObject({
			"origin-auth": "share-publicly",
		});
	});

	it("lets Cloudflare's signed subrequest read a private original without a token", async () => {
		const request = mediaApp({ MEDIA_BUCKET: await privateGifBucket() });
		const authorization = await imageOriginAuthorization(DELIVERY_SECRET, { url: ORIGIN_URL, scope: "" });
		const response = await request(`/v1/media/${PRIVATE_GIF}`, { headers: { via: VIA, Authorization: authorization } });
		expect(response.status).toBe(200);
	});

	it("does not trust a bare Via header", async () => {
		const request = mediaApp({ MEDIA_BUCKET: await privateGifBucket() });
		expect((await request(`/v1/media/${PRIVATE_GIF}`, { headers: { via: VIA } })).status).toBe(401);
	});

	it("rejects a credential minted for another storage prefix", async () => {
		const request = mediaApp({ MEDIA_BUCKET: await privateGifBucket() });
		const authorization = await imageOriginAuthorization(DELIVERY_SECRET, { url: ORIGIN_URL, scope: "prefix-b/" });
		const response = await request(`/v1/media/${PRIVATE_GIF}`, { headers: { via: VIA, Authorization: authorization } });
		expect(response.status).toBe(401);
	});

	it("binds the credential to its URL and scope, and returns the signed scope", async () => {
		const otherUrl = new URL("https://media.test/v1/media/private/image/b/other.gif");
		const authorization = await imageOriginAuthorization(DELIVERY_SECRET, { url: otherUrl, scope: "prefix-a/" });
		expect(await readImageOriginScope(originRequest(ORIGIN_URL, authorization), DELIVERY_SECRET)).toBeNull();
		expect(await readImageOriginScope(originRequest(otherUrl, authorization), DELIVERY_SECRET)).toBe("prefix-a/");
		expect(await readImageOriginScope(originRequest(otherUrl, authorization), "other-secret")).toBeNull();
		const [, signature] = authorization.slice("Bearer dvo.".length).split(".");
		const tampered = `Bearer dvo.${btoa("prefix-b/").replace(/=+$/, "")}.${signature}`;
		expect(await readImageOriginScope(originRequest(otherUrl, tampered), DELIVERY_SECRET)).toBeNull();
	});
});

describe("fit", () => {
	it("maps fill to Cloudflare's squeeze and passes the rest through", () => {
		expect(cloudflareImageOptions({ width: 40, height: 40, fit: "fill" }, null).fit).toBe("squeeze");
		expect(cloudflareImageOptions({ width: 40, fit: "cover" }, null).fit).toBe("cover");
		expect(cloudflareImageOptions({ width: 40 }, null).fit).toBeUndefined();
	});
});

describe("format=auto on the fallback", () => {
	const small = { width: 400, format: "auto" };
	const large = { width: 1600, format: "auto" };
	const modern = "image/avif,image/webp,*/*";

	it("never passes auto through: it resolves the format from Accept", () => {
		expect(cloudflareOutputFormat(small, modern, "image/jpeg")).toBe("avif");
		expect(cloudflareOutputFormat(large, modern, "image/jpeg")).toBe("webp");
		expect(cloudflareOutputFormat(small, "image/webp,*/*", "image/png")).toBe("webp");
		expect(cloudflareOutputFormat(small, "*/*", "image/jpeg")).toBe("jpeg");
		expect(cloudflareOutputFormat(small, "*/*", "image/png")).toBe("png");
	});

	it("keeps animation: no AVIF for sources that may be animated, GIF stays GIF without WebP", () => {
		expect(cloudflareOutputFormat(small, modern, "image/gif")).toBe("webp");
		expect(cloudflareOutputFormat(small, "*/*", "image/gif")).toBeNull();
	});

	it("leaves explicit formats and no format alone", () => {
		expect(cloudflareOutputFormat({ width: 400, format: "png" }, modern, "image/jpeg")).toBe("png");
		expect(cloudflareOutputFormat({ width: 400 }, modern, "image/jpeg")).toBeNull();
	});

	it("answers the fallback with Vary: Accept", async () => {
		const cloudflare = stubCloudflare();
		const request = mediaApp({ MEDIA_BUCKET: await privateGifBucket() });
		const response = await request(`/v1/media/${PRIVATE_GIF}?w=48&format=auto&token=${await viewerToken()}`, {
			headers: { Accept: modern },
		});
		expect(response.headers.get("Vary")).toBe("Accept");
		expect((cloudflare.mock.calls[0][1] as RequestInit & { cf: { image: object } }).cf.image).toMatchObject({
			format: "webp",
		});
	});
});
