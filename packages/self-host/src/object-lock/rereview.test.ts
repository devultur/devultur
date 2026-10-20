// Regression tests from the second review of the object lock: each one fails on the code before its fix.
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportsWorker } from "../exports-test-harness";
import { MAX_EXPIRED_LOOKUPS } from "../routes/assets";
import { lockedFixture } from "./worker-fixture";

const empty = (customMetadata: Record<string, string> = {}) => ({
	bytes: new Uint8Array(1),
	httpMetadata: {},
	customMetadata,
});
const PAST = String(Date.now() - 60_000);
const FUTURE = String(Date.now() + 3_600_000);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function quiet() {
	vi.spyOn(console, "log").mockImplementation(() => {});
}

type Send = (path: string, init?: RequestInit) => Response | Promise<Response>;

async function uploadPdf(send: Send, body: Record<string, unknown>) {
	const created = await send("/v1/upload", {
		method: "POST",
		body: JSON.stringify({ filename: "a.pdf", contentType: "application/pdf", ...body }),
	});
	const { key, uploadUrl } = (await created.json()) as { key: string; uploadUrl: string };
	const put = await send(uploadUrl, { method: "PUT", body: "bytes", headers: { "Content-Type": "application/pdf" } });
	expect(put.status).toBe(200);
	return key;
}

const holdKey = (send: Send, key: string) =>
	send("/v1/lock/hold", { method: "POST", body: JSON.stringify({ hold: true, keys: [key] }) });

describe("2. a lock change on the new object outlives the write that replaced the old one", () => {
	it("a hold set on v2 right after an overwrite landed stays", async () => {
		quiet();
		const { send, mediaBucket } = lockedFixture();
		const key = await uploadPdf(send, { path: "docs/race.pdf" });
		const realPut = mediaBucket.put;
		let isRacing = true;
		mediaBucket.put = async (target, value, options) => {
			const stored = await realPut(target, value, options);
			if (target === key && isRacing) {
				isRacing = false;
				expect((await holdKey(send, key)).status).toBe(200);
			}
			return stored;
		};
		await uploadPdf(send, { path: "docs/race.pdf", overwrite: true });
		expect(await (await send(`/v1/lock/${key}`)).json()).toMatchObject({ hold: true, source: "sidecar" });
	});

	it("a hold set on a re-upload made while the delete was finishing stays", async () => {
		quiet();
		const { send, keysBucket } = lockedFixture();
		const key = await uploadPdf(send, { path: "docs/again.pdf" });
		// The object and its variants are gone; its keys are being swept: a new file lands and gets a hold.
		const realList = keysBucket.list;
		let isRacing = true;
		keysBucket.list = async (options) => {
			if (isRacing && options.prefix?.includes(key)) {
				isRacing = false;
				await uploadPdf(send, { path: "docs/again.pdf" });
				await holdKey(send, key);
			}
			return realList(options);
		};
		expect((await send(`/v1/media/${key}`, { method: "DELETE" })).status).toBe(204);
		expect(await (await send(`/v1/lock/${key}`)).json()).toMatchObject({ hold: true, source: "sidecar" });
	});
});

describe("3. listing expired entries is bounded", () => {
	it(`reads at most ${MAX_EXPIRED_LOOKUPS} lock records per page and resumes after the last entry`, async () => {
		const { send, mediaBucket } = lockedFixture();
		const expiredCount = MAX_EXPIRED_LOOKUPS + 8;
		for (let index = 0; index < expiredCount; index += 1) {
			const key = `private/asset/docs/n${String(index).padStart(3, "0")}.pdf`;
			mediaBucket.objects.set(key, empty({ expiresAt: PAST, lock: JSON.stringify({ hold: true }) }));
		}
		mediaBucket.objects.set("private/asset/docs/z-fresh.pdf", empty());
		const get = vi.spyOn(mediaBucket, "get");
		const page = async (cursor?: string) => {
			get.mockClear();
			const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
			const res = await send(`/v1/assets?visibility=private${query}`);
			expect(get.mock.calls.length).toBeLessThanOrEqual(MAX_EXPIRED_LOOKUPS);
			return (await res.json()) as { objects: { key: string; expired?: true }[]; cursor: string | null };
		};

		const first = await page();
		expect(first.objects).toHaveLength(MAX_EXPIRED_LOOKUPS);
		expect(first.cursor).toMatch(/^private:~/);
		const second = await page(first.cursor ?? undefined);
		expect(second.cursor).toBeNull();
		const keys = [...first.objects, ...second.objects].map((entry) => entry.key);
		expect(new Set(keys).size).toBe(expiredCount + 1);
		expect(second.objects.at(-1)).toEqual(expect.objectContaining({ key: "private/asset/docs/z-fresh.pdf" }));
	});
});

describe("4. a video's derived outputs expire with it", () => {
	const RAW = "private/video/vid9/raw/clip.mp4";

	it("a transcode output PUT inherits the raw's expiresAt", async () => {
		const { send, mediaBucket } = lockedFixture();
		mediaBucket.objects.set(RAW, empty({ expiresAt: FUTURE }));
		const key = "private/video/vid9/hls/playlist.m3u8";
		const put = await send(`/v1/upload/${key}`, {
			method: "PUT",
			body: "#EXTM3U",
			headers: { "Content-Type": "application/vnd.apple.mpegurl" },
		});
		expect(put.status).toBe(200);
		expect(mediaBucket.objects.get(key)?.customMetadata.expiresAt).toBe(FUTURE);
	});

	it("a transcode output's multipart inherits it too", async () => {
		const { send, mediaBucket } = lockedFixture();
		mediaBucket.objects.set(RAW, empty({ expiresAt: FUTURE }));
		const create = vi.spyOn(mediaBucket, "createMultipartUpload");
		const key = "private/video/vid9/mp4/main-720p.mp4";
		const res = await send(`/v1/upload/${key}?multipart=create`, {
			method: "POST",
			body: JSON.stringify({ size: 20 * 1024 * 1024, contentType: "video/mp4" }),
		});
		expect(res.status).toBe(200);
		expect(create.mock.calls[0]?.[1]?.customMetadata?.expiresAt).toBe(FUTURE);
	});

	it("captions inherit their source's expiresAt", async () => {
		quiet();
		const { send, mediaBucket, env } = lockedFixture();
		mediaBucket.objects.set(RAW, empty({ expiresAt: FUTURE }));
		Object.assign(env, { GROQ_API_KEY: "g", MISTRAL_API_KEY: "m" });
		const transcript = {
			language: "en",
			duration: 1,
			text: "hi",
			segments: [],
			words: [{ word: "hi", start: 0, end: 1 }],
		};
		vi.stubGlobal("fetch", async (url: string | URL) =>
			String(url).includes("groq") ? Response.json(transcript) : new Response("ok"),
		);
		const res = await send("/v1/captions", { method: "POST", body: JSON.stringify({ key: RAW, locales: ["en"] }) });
		expect(res.status).toBe(200);
		expect(mediaBucket.objects.get("private/video/vid9/captions/en.vtt")?.customMetadata.expiresAt).toBe(FUTURE);
	});
});

describe("6. an overwritten version's encryption key doesn't outlive it", () => {
	async function encryptedAsset() {
		const worker = exportsWorker({ security: { encrypt: true } });
		const upload = async (overwrite: boolean) => {
			const created = await worker.postJson("/v1/upload", { contentType: "application/zip", path: "x/a", overwrite });
			const { key, uploadUrl } = (await created.json()) as { key: string; uploadUrl: string };
			await worker.send(uploadUrl, { method: "PUT", body: "zip", headers: { "Content-Type": "application/zip" } });
			return key;
		};
		const ownKeys = (key: string) =>
			[...worker.keysBucket.objects.keys()].filter((k) => k.startsWith(`prefix-a/${key}/`));
		return { worker, upload, ownKeys };
	}

	it("an overwrite deletes the replaced version's key", async () => {
		const { upload, ownKeys } = await encryptedAsset();
		const key = await upload(false);
		const [firstKey] = ownKeys(key);
		await upload(true);
		expect(ownKeys(key)).toHaveLength(1);
		expect(ownKeys(key)).not.toContain(firstKey);
	});

	it("a delete sweeps a key an earlier version left behind", async () => {
		const { worker, upload, ownKeys } = await encryptedAsset();
		const key = await upload(false);
		worker.keysBucket.objects.set(`prefix-a/${key}/orphan`, empty());
		expect((await worker.send(`/v1/media/${key}`, { method: "DELETE" })).status).toBe(204);
		expect(ownKeys(key)).toEqual([]);
	});
});

describe("7. an unreadable lock record can't be released or changed through the API", () => {
	const KEY = "private/file/u/u.pdf";

	it.each([
		[
			"an unreadable record",
			(bucket: ReturnType<typeof lockedFixture>["mediaBucket"]) => {
				bucket.objects.set(KEY, empty());
				bucket.objects.set(`__lock/${KEY}`, { ...empty(), bytes: new TextEncoder().encode("{not json") });
			},
		],
		[
			"an unreadable upload lock",
			(bucket: ReturnType<typeof lockedFixture>["mediaBucket"]) => {
				bucket.objects.set(KEY, empty({ lock: "{not json" }));
			},
		],
	])("%s stays held", async (_, seed) => {
		quiet();
		const { send, mediaBucket } = lockedFixture();
		seed(mediaBucket);

		const release = await send("/v1/lock/hold", { method: "POST", body: JSON.stringify({ hold: false, keys: [KEY] }) });
		expect(await release.json()).toEqual({ updated: [], skipped: [{ key: KEY, reason: "lock_record_unreadable" }] });
		const change = await send(`/v1/lock/${KEY}`, {
			method: "PUT",
			body: JSON.stringify({ mode: "governance", period: 1 }),
		});
		expect(change.status).toBe(409);
		expect(await change.json()).toMatchObject({ code: "lock_record_unreadable" });
		expect((await send(`/v1/media/${KEY}`, { method: "DELETE" })).status).toBe(409);
	});
});
