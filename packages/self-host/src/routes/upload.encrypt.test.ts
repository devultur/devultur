import type { SecurityPolicy } from "@devultur/core";
import { decodeEncryptionMeta, decryptChunk, importEncryptionKey } from "@devultur/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { updateRequestState } from "../request-state";
import { sniffableBytes } from "../test-fixtures";
import type { WorkerApp } from "../types";
import { upload } from "./upload";

// Opens with the signature of `signedAs` so the content check passes; null for a type the Worker doesn't sniff.
function bytes(length: number, signedAs: string | null = "image/jpeg"): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) out[i] = (i * 91 + 13) % 256;
	if (signedAs) out.set(sniffableBytes(signedAs, 0));
	return out;
}

// Sets up the upload worker with mocked buckets/KV. `security` = the scope's default (context);
// `pending` = the upload-pending record in KV (carries the security from the POST).
function uploadSetup(options?: { security?: SecurityPolicy; pending?: Record<string, unknown> }) {
	const mediaPut = vi.fn(async (_key: string, _body: unknown, _opts: unknown) => {});
	const keysStore = new Map<string, ArrayBuffer>();
	const keysPut = vi.fn(async (path: string, body: ArrayBuffer) => {
		keysStore.set(path, body);
	});

	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		updateRequestState(context, { storagePrefix: "", access: { authenticated: true } });
		if (options?.security) updateRequestState(context, { config: { security: options.security } });
		await next();
	});
	app.route("/v1/upload", upload);

	const pendingRaw = options?.pending ? JSON.stringify(options.pending) : null;
	const env = {
		MEDIA_BUCKET: { put: mediaPut, head: async () => null, list: async () => ({ objects: [], truncated: false }) },
		KEYS_BUCKET: { put: keysPut, head: async (path: string) => (keysStore.has(path) ? { key: path } : null) },
		MEDIA_KV: {
			get: async (kvKey: string) => (kvKey === `upload-pending:${PENDING_ID}` ? pendingRaw : null),
			put: async () => {},
			delete: async () => {},
		},
	} as unknown as WorkerApp["Bindings"];

	return { app, env, mediaPut, keysPut, keysStore };
}

// The pending's id, carried by the upload URL (`?u=…`).
const PENDING_ID = "pendingIdpendingIdpend";

async function put(
	app: Hono<WorkerApp>,
	env: WorkerApp["Bindings"],
	key: string,
	body: Uint8Array<ArrayBuffer>,
	contentType = "image/jpeg",
	pendingId?: string,
) {
	return app.request(
		`http://worker/v1/upload/${key}${pendingId ? `?u=${pendingId}` : ""}`,
		{ method: "PUT", body, headers: { "Content-Type": contentType } },
		env,
	);
}

function storedCall(mediaPut: ReturnType<typeof vi.fn>) {
	return mediaPut.mock.calls[0] as [string, Uint8Array<ArrayBuffer>, { customMetadata?: Record<string, string> }];
}

describe("upload L4 encryption", () => {
	const key = "private/image/abc/foto.jpg";

	it("with encrypt ON: stores ciphertext + a separate key, and the envelope decrypts back to plaintext", async () => {
		const plaintext = bytes(777);
		const { app, env, mediaPut, keysPut, keysStore } = uploadSetup({ security: { encrypt: true } });
		const res = await put(app, env, key, plaintext);
		expect(res.status).toBe(200);

		expect(keysPut).toHaveBeenCalledTimes(1);
		expect(mediaPut).toHaveBeenCalledTimes(1);

		const [, storedBody, options] = storedCall(mediaPut);
		// The stored body is NOT the plaintext.
		expect(Array.from(storedBody)).not.toEqual(Array.from(plaintext));
		const meta = decodeEncryptionMeta(options.customMetadata?.enc);
		expect(meta).not.toBeNull();

		// The key lives at `${storageKey}/${keyId}` (storagePrefix "" → the virtual key itself); decrypt it.
		const rawKey = keysStore.get(`private/image/abc/foto.jpg/${meta?.keyId}`);
		expect(rawKey).toBeDefined();
		const cryptoKey = await importEncryptionKey(rawKey as ArrayBuffer);
		const decrypted = await decryptChunk(storedBody, cryptoKey, meta?.iv as Uint8Array, 0);
		expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
	});

	it("without a policy (default): does NOT encrypt — plain body, no key, no envelope", async () => {
		const plaintext = bytes(64);
		const { app, env, mediaPut, keysPut } = uploadSetup();
		await put(app, env, key, plaintext);

		expect(keysPut).not.toHaveBeenCalled();
		const [, storedBody, options] = storedCall(mediaPut);
		expect(Array.from(new Uint8Array(storedBody as unknown as ArrayBuffer))).toEqual(Array.from(plaintext));
		expect(options.customMetadata?.enc).toBeUndefined();
	});

	it("public never encrypts even with encrypt ON (tokenless cacheable)", async () => {
		const plaintext = bytes(64);
		const { app, env, keysPut } = uploadSetup({ security: { encrypt: true } });
		await put(app, env, "public/image/abc/foto.jpg", plaintext);
		expect(keysPut).not.toHaveBeenCalled();
	});

	it("encrypts a private video's RAW and THUMBNAIL (at-rest)", async () => {
		for (const [videoKey, ct] of [
			["private/video/vid1/raw/clip.mp4", "video/mp4"],
			["private/video/vid1/hls/thumbnail.jpg", "image/jpeg"],
		] as const) {
			const { app, env, keysPut, mediaPut } = uploadSetup({ security: { encrypt: true } });
			await put(app, env, videoKey, bytes(128, ct), ct);
			expect(keysPut, videoKey).toHaveBeenCalledTimes(1);
			// The key lives at `${storageKey}/${keyId}` = the object's own path + keyId.
			expect(keysPut.mock.calls[0][0], videoKey).toMatch(new RegExp(`^${videoKey}/`));
			expect(storedCall(mediaPut)[2].customMetadata?.enc, videoKey).toBeDefined();
		}
	});

	it("does NOT encrypt HLS segments/playlists (transcode encrypts them with AES-128)", async () => {
		for (const [hlsKey, ct] of [
			["private/video/vid1/hls/720p_000.ts", "video/mp2t"],
			["private/video/vid1/hls/720p.m3u8", "application/vnd.apple.mpegurl"],
		] as const) {
			const { app, env, keysPut, mediaPut } = uploadSetup({ security: { encrypt: true } });
			await put(app, env, hlsKey, bytes(64, null), ct);
			expect(keysPut, hlsKey).not.toHaveBeenCalled();
			expect(storedCall(mediaPut)[2].customMetadata?.enc, hlsKey).toBeUndefined();
		}
	});

	it("with a prefix: the key path uses pending.storageKey's PREFIX, not the empty context.storagePrefix", async () => {
		// The client's PUT is credential-less → the scope's storage prefix is empty. The object gets stored at
		// pending.storageKey ({prefix}/…); the key MUST hang off the same path so delivery (fullKey via
		// token.aud) can find it. Without this → a key with no prefix → 500.
		const { app, env, keysPut, mediaPut } = uploadSetup({
			security: { encrypt: true },
			pending: { contentType: "image/jpeg", storageKey: "prefix-a/private/image/abc/foto.jpg", key },
		});
		await put(app, env, key, bytes(96), "image/jpeg", PENDING_ID);
		expect(keysPut).toHaveBeenCalledTimes(1);
		const keyId = decodeEncryptionMeta(storedCall(mediaPut)[2].customMetadata?.enc)?.keyId;
		// Hangs off the object's REAL storage key (with the prefix), not the prefix-less virtual key.
		expect(keysPut.mock.calls[0][0]).toBe(`prefix-a/private/image/abc/foto.jpg/${keyId}`);
	});
});

// Regression for the "encrypt at rest" toggle bug: encrypt is decided on the PUT, which is
// credential-less (capability URL) → it has NO config policy in context. The POST (which does have it)
// MUST persist the resolved policy in the pending, or the PUT falls back to default and stores plaintext even
// though the config has encrypt ON. The tests above didn't catch this because the harness injects `security` into
// the context of ALL requests (including the PUT) — here we model the real flow: security only on the POST.
describe("upload L4 encryption — config policy injected by a middleware (POST → PUT credential-less)", () => {
	it("POST with encrypt ON in the config policy → persists security.encrypt=true in the pending", async () => {
		const puts: Record<string, string> = {};
		const app = new Hono<WorkerApp>();
		app.use("*", async (context, next) => {
			updateRequestState(context, { storagePrefix: "", access: { authenticated: true } });
			updateRequestState(context, { config: { security: { sessionBinding: true, encrypt: true } } }); // injected by a middleware
			await next();
		});
		app.route("/v1/upload", upload);
		const env = {
			MEDIA_BUCKET: { put: async () => {} },
			KEYS_BUCKET: { put: async () => {} },
			MEDIA_KV: {
				get: async () => null,
				put: async (k: string, v: string) => {
					puts[k] = v;
				},
				delete: async () => {},
			},
		} as unknown as WorkerApp["Bindings"];

		const res = await app.request(
			"http://worker/v1/upload",
			{
				method: "POST",
				body: JSON.stringify({ filename: "Cédula ciudadanía.jpg", contentType: "image/jpeg" }),
				headers: { "Content-Type": "application/json" },
			},
			env,
		);
		expect(res.status).toBe(200);

		// The stored pending carries the RESOLVED policy (config ⊕ override) with encrypt=true → the
		// credential-less PUT applies it. Without the fix, the POST only persisted `body.security` (absent) → no encryption.
		const pendingRaw = Object.values(puts).find((v) => v.includes("storageKey"));
		expect(pendingRaw).toBeDefined();
		const pending = JSON.parse(pendingRaw as string);
		expect(pending.security).toMatchObject({ encrypt: true });
	});

	it("credential-less PUT (no security in context) encrypts from the pending the POST persisted", async () => {
		// Production scenario: the PUT has NO context.var.security; the policy travels in the pending.
		const plaintext = bytes(512);
		const { app, env, mediaPut, keysPut } = uploadSetup({
			pending: {
				contentType: "image/jpeg",
				storageKey: "prefix-a/private/image/abc/foto.jpg",
				key: "private/image/abc/foto.jpg",
				security: { encrypt: true },
			},
		});
		const res = await put(app, env, "private/image/abc/foto.jpg", plaintext, "image/jpeg", PENDING_ID);
		expect(res.status).toBe(200);
		expect(keysPut).toHaveBeenCalledTimes(1);
		const [, storedBody, options] = storedCall(mediaPut);
		expect(Array.from(storedBody)).not.toEqual(Array.from(plaintext)); // ciphertext, not plaintext
		expect(options.customMetadata?.enc).toBeDefined();
	});
});
