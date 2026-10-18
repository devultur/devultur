import {
	computeFingerprint,
	encodeEncryptionMeta,
	encryptBytes,
	exportEncryptionKey,
	generateEncryptionKey,
	generateIv,
} from "@devultur/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { updateRequestState } from "../request-state";
import type { WorkerApp } from "../types";
import { media } from "./media";

const SECRET = "delivery-sign-secret";

async function signToken(payload: Record<string, unknown>, secret: string): Promise<string> {
	const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	const signingInput = `${b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64(JSON.stringify(payload))}`;
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
	const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return `${signingInput}.${sigB64}`;
}

const now = () => Math.floor(Date.now() / 1000);
const validToken = () => signToken({ sub: "u", exp: now() + 3600 }, SECRET);

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function bytes(length: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) out[i] = (i * 53 + 7) % 256;
	return out;
}

// Sets up a worker with MEDIA_BUCKET + KEYS_BUCKET mocked around ONE encrypted object. The key lives
// under `${fullKey}/${keyId}` (fullKey = the object's storage key). With storagePrefix "" and the request
// `private/image/abc/foto.jpg`, the path is `private/image/abc/foto.jpg/key0`.
async function encryptedSetup(plaintext: Uint8Array<ArrayBuffer>) {
	const cryptoKey = await generateEncryptionKey();
	const iv = generateIv();
	const ciphertext = await encryptBytes(plaintext, cryptoKey, iv);
	const keyId = "key0";
	const enc = encodeEncryptionMeta(iv, keyId);
	const keyPath = `private/image/abc/foto.jpg/${keyId}`;
	const rawKey = await exportEncryptionKey(cryptoKey);

	const mediaObject = (start = 0, end = ciphertext.length) => ({
		httpMetadata: { contentType: "image/jpeg" },
		customMetadata: { enc },
		size: ciphertext.length,
		httpEtag: '"e"',
		body: streamOf(ciphertext.subarray(start, end)),
		async arrayBuffer() {
			return ciphertext.slice(start, end).buffer;
		},
	});

	const mediaBucket = {
		get: async (_key: string, options?: { range?: { offset: number; length: number } }) => {
			if (options?.range) {
				const { offset, length } = options.range;
				return mediaObject(offset, offset + length);
			}
			return mediaObject();
		},
	};
	const keysBucket = {
		get: async (path: string) => (path === keyPath ? { arrayBuffer: async () => rawKey.buffer } : null),
	};

	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		updateRequestState(context, { storagePrefix: "" });
		await next();
	});
	app.route("/v1/media", media);

	const env = {
		MEDIA_BUCKET: mediaBucket,
		KEYS_BUCKET: keysBucket,
		DELIVERY_SIGN_SECRET: SECRET,
	} as unknown as WorkerApp["Bindings"];

	return { app, env, ciphertext };
}

async function bodyBytes(res: Response): Promise<Uint8Array> {
	return new Uint8Array(await res.arrayBuffer());
}

describe("media gate (L4 encryption)", () => {
	const path = "/v1/media/private/image/abc/foto.jpg";

	it("delivery decrypts: the client receives the plaintext, not the ciphertext", async () => {
		const plaintext = bytes(1000);
		const { app, env, ciphertext } = await encryptedSetup(plaintext);
		const res = await app.request(`http://worker${path}?token=${await validToken()}`, {}, env);
		expect(res.status).toBe(200);
		const served = await bodyBytes(res);
		expect(Array.from(served)).toEqual(Array.from(plaintext));
		expect(Array.from(served)).not.toEqual(Array.from(ciphertext));
	});

	it("Range: decrypts only the requested range and aligns it to a block", async () => {
		const plaintext = bytes(512);
		const { app, env } = await encryptedSetup(plaintext);
		// Range that does NOT start at a block boundary (byte 100), to exercise trimming the excess.
		const res = await app.request(
			`http://worker${path}?token=${await validToken()}`,
			{ headers: { Range: "bytes=100-267" } },
			env,
		);
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Range")).toBe("bytes 100-267/512");
		expect(res.headers.get("Content-Length")).toBe("168");
		expect(Array.from(await bodyBytes(res))).toEqual(Array.from(plaintext.subarray(100, 268)));
	});

	it("without the key (bucket missing) → 500, never leaks ciphertext", async () => {
		const plaintext = bytes(64);
		const { app, env } = await encryptedSetup(plaintext);
		const brokenEnv = { ...env, KEYS_BUCKET: undefined } as unknown as WorkerApp["Bindings"];
		const res = await app.request(`http://worker${path}?token=${await validToken()}`, {}, brokenEnv);
		expect(res.status).toBe(500);
	});
});

describe("media gate (L4 raw video, internal transcode download)", () => {
	it("decrypts the raw with the download token (aud, binding off) → transcode receives plaintext", async () => {
		const plaintext = bytes(300);
		const cryptoKey = await generateEncryptionKey();
		const iv = generateIv();
		const ciphertext = await encryptBytes(plaintext, cryptoKey, iv);
		const keyId = "key0";
		const rawKey = await exportEncryptionKey(cryptoKey);
		// Key under `${fullKey}/${keyId}`; with storagePrefix "prefix-a/" and the request to the raw, this is the path.
		const keyPath = "prefix-a/private/video/vid1/raw/clip.mp4/key0";

		const mediaBucket = {
			get: async () => ({
				httpMetadata: { contentType: "video/mp4" },
				customMetadata: { enc: encodeEncryptionMeta(iv, keyId) },
				size: ciphertext.length,
				httpEtag: '"e"',
				body: streamOf(ciphertext),
			}),
		};
		const keysBucket = {
			get: async (p: string) => (p === keyPath ? { arrayBuffer: async () => rawKey.buffer } : null),
		};

		const app = new Hono<WorkerApp>();
		app.use("*", async (context, next) => {
			updateRequestState(context, { storagePrefix: "prefix-a/" });
			await next();
		});
		app.route("/v1/media", media);
		const env = {
			MEDIA_BUCKET: mediaBucket,
			KEYS_BUCKET: keysBucket,
			DELIVERY_SIGN_SECRET: SECRET,
		} as unknown as WorkerApp["Bindings"];

		// Service download token: no fp/nonce, binding off, with aud → locates the key.
		const token = await signToken(
			{ sub: "transcode:vid1", aud: "prefix-a", bind: { sessionBinding: false }, exp: now() + 3600 },
			SECRET,
		);
		const res = await app.request(`http://worker/v1/media/private/video/vid1/raw/clip.mp4?token=${token}`, {}, env);
		expect(res.status).toBe(200);
		expect(Array.from(await bodyBytes(res))).toEqual(Array.from(plaintext));
	});
});

describe("media gate (L4 HLS key endpoint)", () => {
	const keyPath = "/v1/media/private/video/vid1/hls/key0.key";
	const rawKey = new Uint8Array(16).fill(7);

	function keySetup(customMetadata?: Record<string, string>) {
		// serveEncryptionKey derives the request path without `.key`, with the storage prefix: with storagePrefix ""
		// and `private/video/vid1/hls/key0.key` → `private/video/vid1/hls/key0`.
		const keysBucket = {
			get: async (path: string) =>
				path === "private/video/vid1/hls/key0" ? { body: streamOf(rawKey), size: rawKey.length, customMetadata } : null,
		};
		const app = new Hono<WorkerApp>();
		app.use("*", async (context, next) => {
			updateRequestState(context, { storagePrefix: "" });
			await next();
		});
		app.route("/v1/media", media);
		const env = {
			MEDIA_BUCKET: { get: async () => null },
			KEYS_BUCKET: keysBucket,
			DELIVERY_SIGN_SECRET: SECRET,
		} as unknown as WorkerApp["Bindings"];
		return { app, env };
	}

	it("with a valid token → 200 + the 16 raw bytes of the key, no-store", async () => {
		const { app, env } = keySetup();
		const res = await app.request(`http://worker${keyPath}?token=${await validToken()}`, {}, env);
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toContain("no-store");
		expect(Array.from(await bodyBytes(res))).toEqual(Array.from(rawKey));
	});

	it("without a token → 401 (the key is never served tokenless)", async () => {
		const { app, env } = keySetup();
		const res = await app.request(`http://worker${keyPath}`, {}, env);
		expect(res.status).toBe(401);
	});

	it("per-resource binding: the key's metadata requires sessionBinding → 401 if the fingerprint mismatches", async () => {
		const { app, env } = keySetup({ security: JSON.stringify({ sessionBinding: true }) });
		const nonce = "n1";
		// Token with the fp of UA "match"; the request arrives with a different UA → mismatch.
		const token = await signToken(
			{ sub: "u", nonce, fp: await computeFingerprint("u", "UA-match", nonce), exp: now() + 3600 },
			SECRET,
		);
		const res = await app.request(
			`http://worker${keyPath}?token=${token}`,
			{ headers: { "User-Agent": "UA-other" } },
			env,
		);
		expect(res.status).toBe(401);
		expect(((await res.json()) as { code?: string }).code).toBe("session_mismatch");
	});
});

describe("media gate (.key is HLS-only, does not collide with user files)", () => {
	it("a private file named `*.key` outside /hls/ is served as a normal object", async () => {
		const object = {
			httpMetadata: { contentType: "application/octet-stream" },
			customMetadata: {},
			size: 3,
			httpEtag: '"e"',
			body: streamOf(new Uint8Array([1, 2, 3])),
		};
		const app = new Hono<WorkerApp>();
		app.use("*", async (context, next) => {
			updateRequestState(context, { storagePrefix: "" });
			await next();
		});
		app.route("/v1/media", media);
		const env = {
			MEDIA_BUCKET: { get: async () => object },
			// If this were routed to the key endpoint, it would query KEYS_BUCKET (which would throw here) → the 200 proves it doesn't.
			KEYS_BUCKET: {
				get: async () => {
					throw new Error("should not query KEYS_BUCKET for a user file");
				},
			},
			DELIVERY_SIGN_SECRET: SECRET,
		} as unknown as WorkerApp["Bindings"];
		const res = await app.request(
			`http://worker/v1/media/private/file/abc/licencia.key?token=${await validToken()}`,
			{},
			env,
		);
		expect(res.status).toBe(200);
		expect(Array.from(await bodyBytes(res))).toEqual([1, 2, 3]);
	});
});

describe("media gate (L4 playlist key URI rewrite)", () => {
	it("tokenizes the #EXT-X-KEY URI and the segment lines", async () => {
		const playlist = ["#EXTM3U", '#EXT-X-KEY:METHOD=AES-128,URI="key0.key"', "#EXTINF:6,", "seg0.ts"].join("\n");
		const object = {
			httpMetadata: { contentType: "application/vnd.apple.mpegurl" },
			customMetadata: {},
			size: playlist.length,
			httpEtag: '"e"',
			async text() {
				return playlist;
			},
		};
		const app = new Hono<WorkerApp>();
		app.use("*", async (context, next) => {
			updateRequestState(context, { storagePrefix: "" });
			await next();
		});
		app.route("/v1/media", media);
		const env = {
			MEDIA_BUCKET: { get: async () => object },
			DELIVERY_SIGN_SECRET: SECRET,
		} as unknown as WorkerApp["Bindings"];

		const token = await validToken();
		const res = await app.request(`http://worker/v1/media/private/video/vid1/hls/720p.m3u8?token=${token}`, {}, env);
		const text = await res.text();
		expect(text).toContain(`URI="key0.key?token=${token}"`);
		expect(text).toContain(`seg0.ts?token=${token}`);
	});
});
