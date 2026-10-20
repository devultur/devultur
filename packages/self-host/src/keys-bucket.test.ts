// Encryption at rest fails closed: with `security.encrypt` on and no `KEYS_BUCKET`, every write path of a private
// file answers `503 keys_bucket_missing` and stores nothing. With the bucket bound, the same writes are encrypted.
import { decodeEncryptionMeta, type SecurityPolicy } from "@devultur/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryBucket } from "./exports-test-harness";
import { encryptForStorage, shouldEncryptAtRest } from "./helpers";
import { DerivedKind, storeDerived } from "./image/storage";
import { createWorker } from "./index";
import { KEYS_BUCKET_MISSING_CODE } from "./keys-bucket";
import { defaultPlugins } from "./plugins";
import { WORKER_SECRETS, withWorkerAuth } from "./plugins/worker-secret-auth-test-env";
import type { TranscodeContainerNamespace } from "./transcode/cloudflare";
import type { WorkerEnv } from "./types";

const ENCRYPT_ON: SecurityPolicy = { encrypt: true };
const PRIVATE_IMAGE = "private/image/img1/photo.jpg";
const PRIVATE_RAW = "private/video/vid1/raw/clip.mp4";
const PUBLIC_RAW = "public/video/vid1/raw/clip.mp4";

function setup(options: { hasKeysBucket: boolean; security?: SecurityPolicy }) {
	const mediaBucket = memoryBucket();
	const keysBucket = memoryBucket();
	const kv = new Map<string, string>();
	const launches: unknown[] = [];
	const transcodeContainer: TranscodeContainerNamespace = {
		idFromName: (name) => name as unknown as DurableObjectId,
		get: () => ({
			launch: async (request) => {
				launches.push(request);
				return { alreadyRunning: false };
			},
			cancel: async () => {},
		}),
	};
	const env: Record<string, unknown> = {
		...WORKER_SECRETS,
		DELIVERY_SIGN_SECRET: "delivery",
		GROQ_API_KEY: "groq",
		MISTRAL_API_KEY: "mistral",
		TRANSCODE_RUNNER: "cloudflare",
		TRANSCODE_CONTAINER: transcodeContainer,
		MEDIA_BUCKET: mediaBucket,
		MEDIA_KV: {
			get: async (key: string, type?: string) => {
				const value = kv.get(key) ?? null;
				return type === "json" && value ? JSON.parse(value) : value;
			},
			put: async (key: string, value: string) => void kv.set(key, value),
			delete: async (key: string) => void kv.delete(key),
		},
		...(options.hasKeysBucket ? { KEYS_BUCKET: keysBucket } : {}),
	};
	const app = createWorker({ plugins: defaultPlugins({ security: options.security ?? ENCRYPT_ON }) });
	const executionCtx = { waitUntil() {}, passThroughOnException() {} };
	const send = (path: string, init?: RequestInit) =>
		app.request(`https://media.example${path}`, withWorkerAuth(init), env as never, executionCtx as never);
	const json = (path: string, body: unknown) => send(path, { method: "POST", body: JSON.stringify(body) });
	return { env, send, json, mediaBucket, keysBucket, kv, launches };
}

async function expectKeysBucketMissing(response: Response) {
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({ code: KEYS_BUCKET_MISSING_CODE });
}

const createImageUpload = { filename: "photo.jpg", contentType: "image/jpeg" };

afterEach(() => vi.unstubAllGlobals());

describe("shouldEncryptAtRest", () => {
	it("depends only on the policy and the key, not on the bindings", () => {
		expect(shouldEncryptAtRest(ENCRYPT_ON, PRIVATE_IMAGE)).toBe(true);
		expect(shouldEncryptAtRest(ENCRYPT_ON, "public/image/img1/photo.jpg")).toBe(false);
		expect(shouldEncryptAtRest(ENCRYPT_ON, "private/video/vid1/hls/720p_000.ts")).toBe(false);
		expect(shouldEncryptAtRest(ENCRYPT_ON, "private/video/vid1/hls/720p.m3u8")).toBe(false);
		expect(shouldEncryptAtRest({}, PRIVATE_IMAGE)).toBe(false);
	});
});

describe("POST /v1/upload (upload URL issuance)", () => {
	it("refuses a private upload before the client sends any bytes, and leaves no pending", async () => {
		const { json, kv } = setup({ hasKeysBucket: false });
		await expectKeysBucketMissing(await json("/v1/upload", createImageUpload));
		expect(kv.size).toBe(0);
	});

	it("refuses when only the per-upload override turns encryption on", async () => {
		const { json } = setup({ hasKeysBucket: false, security: {} });
		await expectKeysBucketMissing(await json("/v1/upload", { ...createImageUpload, security: ENCRYPT_ON }));
	});

	it("still issues public uploads, and private ones when encryption is off", async () => {
		const publicUpload = await setup({ hasKeysBucket: false }).json("/v1/upload", {
			...createImageUpload,
			visibility: "public",
		});
		expect(publicUpload.status).toBe(200);
		const unencrypted = await setup({ hasKeysBucket: false, security: {} }).json("/v1/upload", createImageUpload);
		expect(unencrypted.status).toBe(200);
	});
});

describe("PUT /v1/upload/<key> (single upload)", () => {
	const putBytes = (send: ReturnType<typeof setup>["send"], key: string, contentType = "image/jpeg") =>
		send(`/v1/upload/${key}`, { method: "PUT", body: new Uint8Array(64), headers: { "Content-Type": contentType } });

	it("refuses to store a private file in plaintext", async () => {
		const { send, mediaBucket } = setup({ hasKeysBucket: false });
		await expectKeysBucketMissing(await putBytes(send, PRIVATE_IMAGE));
		expect(mediaBucket.objects.size).toBe(0);
	});

	it("refuses a pending issued before the keys bucket was unbound", async () => {
		const { json, send, env, mediaBucket } = setup({ hasKeysBucket: true });
		const { uploadUrl } = (await (await json("/v1/upload", createImageUpload)).json()) as { uploadUrl: string };
		delete env.KEYS_BUCKET;
		const response = await send(uploadUrl, {
			method: "PUT",
			body: new Uint8Array(8),
			headers: { "Content-Type": "image/jpeg" },
		});
		await expectKeysBucketMissing(response);
		expect(mediaBucket.objects.size).toBe(0);
	});

	it("leaves HLS segments and public files as they were", async () => {
		const { send, mediaBucket } = setup({ hasKeysBucket: false });
		expect((await putBytes(send, "private/video/vid1/hls/720p_000.ts", "video/mp2t")).status).toBe(200);
		expect((await putBytes(send, "public/image/img1/photo.jpg")).status).toBe(200);
		expect(mediaBucket.objects.size).toBe(2);
	});

	it("encrypts with the keys bucket bound", async () => {
		const { send, mediaBucket, keysBucket } = setup({ hasKeysBucket: true });
		expect((await putBytes(send, PRIVATE_IMAGE)).status).toBe(200);
		expect(decodeEncryptionMeta(mediaBucket.objects.get(PRIVATE_IMAGE)?.customMetadata.enc)).not.toBeNull();
		expect(keysBucket.objects.size).toBe(1);
	});
});

describe("multipart create", () => {
	const derivedMp4 = "private/video/vid1/mp4/main-720p.mp4";
	const createMultipart = (json: ReturnType<typeof setup>["json"], path: string) =>
		json(`${path}${path.includes("?") ? "&" : "?"}multipart=create`, { size: 1024, contentType: "video/mp4" });

	it("refuses a client's large upload before opening an R2 session", async () => {
		const { json, env, mediaBucket } = setup({ hasKeysBucket: true });
		const created = await json("/v1/upload", { filename: "clip.mp4", contentType: "video/mp4", size: 1024 });
		const { uploadUrl } = (await created.json()) as { uploadUrl: string };
		delete env.KEYS_BUCKET;
		const createSession = vi.spyOn(mediaBucket, "createMultipartUpload");
		await expectKeysBucketMissing(await createMultipart(json, uploadUrl));
		expect(createSession).not.toHaveBeenCalled();
	});

	it("refuses a runner's derived asset of a private video", async () => {
		const { json, kv } = setup({ hasKeysBucket: false });
		await expectKeysBucketMissing(await createMultipart(json, `/v1/upload/${derivedMp4}`));
		expect(kv.size).toBe(0);
	});

	it("encrypts with the keys bucket bound", async () => {
		const { json, keysBucket } = setup({ hasKeysBucket: true });
		expect((await createMultipart(json, `/v1/upload/${derivedMp4}`)).status).toBe(200);
		expect(keysBucket.objects.size).toBe(1);
	});
});

describe("POST /v1/transcode", () => {
	const putRaw = async (mediaBucket: ReturnType<typeof memoryBucket>, key: string) =>
		mediaBucket.put(key, new Uint8Array(16), { httpMetadata: { contentType: "video/mp4" } });

	it("refuses to launch a private video whose segments couldn't be encrypted", async () => {
		const { json, mediaBucket, launches } = setup({ hasKeysBucket: false });
		await putRaw(mediaBucket, PRIVATE_RAW);
		await expectKeysBucketMissing(await json("/v1/transcode", { key: PRIVATE_RAW }));
		expect(launches).toHaveLength(0);
	});

	it("launches a public video as before", async () => {
		const { json, mediaBucket, launches } = setup({ hasKeysBucket: false });
		await putRaw(mediaBucket, PUBLIC_RAW);
		expect((await json("/v1/transcode", { key: PUBLIC_RAW })).status).toBe(200);
		expect(launches).toHaveLength(1);
	});

	it("stores the HLS key with the keys bucket bound", async () => {
		const { json, mediaBucket, keysBucket, launches } = setup({ hasKeysBucket: true });
		await putRaw(mediaBucket, PRIVATE_RAW);
		expect((await json("/v1/transcode", { key: PRIVATE_RAW })).status).toBe(200);
		expect(launches).toHaveLength(1);
		expect([...keysBucket.objects.keys()]).toEqual([expect.stringMatching(/^private\/video\/vid1\/hls\//)]);
	});
});

describe("POST /v1/captions", () => {
	function stubProviders() {
		const transcript = {
			language: "en",
			duration: 1,
			text: "hello",
			words: [{ word: "hello", start: 0, end: 1 }],
		};
		const fetchSpy = vi.fn(async (url: string | URL) =>
			String(url).includes("groq") ? Response.json(transcript) : new Response("ok"),
		);
		vi.stubGlobal("fetch", fetchSpy);
		return fetchSpy;
	}

	it("refuses before transcribing, and writes no .vtt", async () => {
		const { json, mediaBucket } = setup({ hasKeysBucket: false });
		await mediaBucket.put(PRIVATE_RAW, new Uint8Array(16));
		const fetchSpy = stubProviders();
		await expectKeysBucketMissing(await json("/v1/captions", { key: PRIVATE_RAW, locales: ["en"] }));
		expect(fetchSpy).not.toHaveBeenCalled();
		expect([...mediaBucket.objects.keys()]).toEqual([PRIVATE_RAW]);
	});

	it("encrypts the .vtt with the keys bucket bound", async () => {
		const { json, mediaBucket } = setup({ hasKeysBucket: true });
		await mediaBucket.put(PRIVATE_RAW, new Uint8Array(16));
		stubProviders();
		expect((await json("/v1/captions", { key: PRIVATE_RAW, locales: ["en"] })).status).toBe(200);
		const caption = mediaBucket.objects.get("private/video/vid1/captions/en.vtt");
		expect(decodeEncryptionMeta(caption?.customMetadata.enc)).not.toBeNull();
	});
});

describe("image variants (storeDerived)", () => {
	it("never stores a plaintext variant of an encrypted original", async () => {
		const { mediaBucket, keysBucket } = setup({ hasKeysBucket: true });
		const { enc } = await encryptForStorage(keysBucket as unknown as R2Bucket, PRIVATE_IMAGE, new Uint8Array(8));
		const original = { customMetadata: { enc } } as unknown as R2Object;
		const variantKey = `${PRIVATE_IMAGE}/__variants/w48.jpeg`;
		const withoutKeys = { MEDIA_BUCKET: mediaBucket } as unknown as WorkerEnv;
		await expect(
			storeDerived(withoutKeys, variantKey, new ArrayBuffer(8), "image/jpeg", original, DerivedKind.VARIANT),
		).rejects.toThrow();
		expect(mediaBucket.objects.has(variantKey)).toBe(false);

		const withKeys = { MEDIA_BUCKET: mediaBucket, KEYS_BUCKET: keysBucket } as unknown as WorkerEnv;
		await storeDerived(withKeys, variantKey, new ArrayBuffer(8), "image/jpeg", original, DerivedKind.VARIANT);
		expect(decodeEncryptionMeta(mediaBucket.objects.get(variantKey)?.customMetadata.enc)).not.toBeNull();
	});
});
