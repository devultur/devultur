import { decryptChunk } from "@devultur/core";
import { describe, expect, it } from "vitest";
import {
	contentDispositionInline,
	encryptForStorage,
	isTranscodeWebhookAuthorized,
	loadStorageKey,
	parseSecurityHeader,
	sanitizeFilename,
	signViewerToken,
	verifyViewerToken,
} from "./helpers";

// Minimal in-memory R2 bucket (put/get with customMetadata) for the encryption helpers.
function memoryBucket() {
	const store = new Map<string, { body: Uint8Array; customMetadata?: Record<string, string> }>();
	return {
		store,
		put: async (key: string, body: ArrayBuffer | Uint8Array, options?: { customMetadata?: Record<string, string> }) => {
			store.set(key, { body: new Uint8Array(body as ArrayBuffer), customMetadata: options?.customMetadata });
		},
		get: async (key: string) => {
			const hit = store.get(key);
			if (!hit) return null;
			return { arrayBuffer: async () => hit.body.buffer, customMetadata: hit.customMetadata };
		},
	} as unknown as R2Bucket & { store: Map<string, { body: Uint8Array; customMetadata?: Record<string, string> }> };
}

// Signs a test viewer token with the same logic as the /v1/token route (HMAC-SHA256).
async function signToken(payload: Record<string, unknown>, secret: string): Promise<string> {
	const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const body = b64(JSON.stringify(payload));
	const signingInput = `${header}.${body}`;
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

describe("verifyViewerToken", () => {
	const secret = "delivery-sign-secret";
	const future = Math.floor(Date.now() / 1000) + 3600;
	const past = Math.floor(Date.now() / 1000) - 10;

	it("accepts a properly signed, current token, and returns the payload", async () => {
		const token = await signToken({ sub: "user-1", aud: "prefix-a/key", exp: future }, secret);
		const payload = await verifyViewerToken(token, secret);
		expect(payload).toMatchObject({ sub: "user-1", aud: "prefix-a/key" });
	});

	it("rejects a missing or malformed token", async () => {
		expect(await verifyViewerToken(undefined, secret)).toBeNull();
		expect(await verifyViewerToken("", secret)).toBeNull();
		expect(await verifyViewerToken("a.b", secret)).toBeNull();
	});

	it("rejects an invalid signature (wrong secret or tampered payload)", async () => {
		const token = await signToken({ sub: "user-1", exp: future }, secret);
		expect(await verifyViewerToken(token, "other-secret")).toBeNull();
		const [h, _p, s] = token.split(".");
		const tampered = `${h}.${btoa(JSON.stringify({ sub: "admin", exp: future }))}.${s}`;
		expect(await verifyViewerToken(tampered, secret)).toBeNull();
	});

	it("rejects an expired token", async () => {
		const token = await signToken({ sub: "user-1", exp: past }, secret);
		expect(await verifyViewerToken(token, secret)).toBeNull();
	});
});

describe("sanitizeFilename", () => {
	it("leaves already-safe names untouched", () => {
		expect(sanitizeFilename("video.mp4")).toBe("video.mp4");
		expect(sanitizeFilename("my_video-01.mp4")).toBe("my_video-01.mp4");
	});

	it("replaces spaces with dashes", () => {
		expect(sanitizeFilename("Mi Video.mp4")).toBe("Mi-Video.mp4");
	});

	it("strips accents/diacritics and lowercases the extension", () => {
		expect(sanitizeFilename("Café Ñandú.MP4")).toBe("Cafe-Nandu.mp4");
	});

	it("collapses runs of special chars into a single dash", () => {
		expect(sanitizeFilename("a # b & c.mp4")).toBe("a-b-c.mp4");
	});

	it("drops emojis and other non-ASCII symbols", () => {
		expect(sanitizeFilename("vidéo 🎬.mp4")).toBe("video.mp4");
	});

	it("keeps interior dots (multi-dot names)", () => {
		expect(sanitizeFilename("my.video.final.mp4")).toBe("my.video.final.mp4");
	});

	it("handles names without an extension", () => {
		expect(sanitizeFilename("report")).toBe("report");
		expect(sanitizeFilename("Mi Archivo")).toBe("Mi-Archivo");
	});

	it("trims leading/trailing dashes and dots", () => {
		expect(sanitizeFilename("  weird .mp4")).toBe("weird.mp4");
	});

	it("falls back to 'file' when the name is all special chars", () => {
		expect(sanitizeFilename("###.mp4")).toBe("file.mp4");
		expect(sanitizeFilename("   .png")).toBe("file.png");
	});

	it("produces a URL-safe key (no chars that break a URL path)", () => {
		const out = sanitizeFilename("Mi Vídeo (final) #1!.MP4");
		expect(out).toMatch(/^[a-zA-Z0-9._-]+$/);
	});
});

describe("contentDispositionInline", () => {
	it("emits inline disposition with both ascii and RFC 5987 filename", () => {
		expect(contentDispositionInline("report.pdf")).toBe(`inline; filename="report.pdf"; filename*=UTF-8''report.pdf`);
	});

	it("percent-encodes spaces in the RFC 5987 part", () => {
		expect(contentDispositionInline("Mi Video.mp4")).toBe(
			`inline; filename="Mi Video.mp4"; filename*=UTF-8''Mi%20Video.mp4`,
		);
	});

	it("keeps the original (incl. accents) in filename* via UTF-8 encoding", () => {
		expect(contentDispositionInline("Café.pdf")).toBe(`inline; filename="Caf_.pdf"; filename*=UTF-8''Caf%C3%A9.pdf`);
	});

	it("neutralizes quotes and backslashes in the ascii fallback", () => {
		expect(contentDispositionInline('a"b\\c.txt')).toBe(`inline; filename="a_b_c.txt"; filename*=UTF-8''a%22b%5Cc.txt`);
	});
});

describe("isTranscodeWebhookAuthorized", () => {
	const secret = "s3cr3t";

	it("rejects every callback when no secret is configured (fail-closed)", () => {
		expect(isTranscodeWebhookAuthorized(undefined, undefined)).toBe(false);
		expect(isTranscodeWebhookAuthorized(undefined, "Bearer anything")).toBe(false);
		expect(isTranscodeWebhookAuthorized("", "Bearer ")).toBe(false);
	});

	it("accepts a matching bearer when the secret is configured", () => {
		expect(isTranscodeWebhookAuthorized(secret, `Bearer ${secret}`)).toBe(true);
	});

	it("rejects a missing, malformed, or wrong bearer", () => {
		expect(isTranscodeWebhookAuthorized(secret, undefined)).toBe(false);
		expect(isTranscodeWebhookAuthorized(secret, "")).toBe(false);
		expect(isTranscodeWebhookAuthorized(secret, secret)).toBe(false); // missing the "Bearer " prefix
		expect(isTranscodeWebhookAuthorized(secret, "Bearer wrong")).toBe(false);
		expect(isTranscodeWebhookAuthorized(secret, `bearer ${secret}`)).toBe(false); // case-sensitive
	});
});

describe("signViewerToken", () => {
	const secret = "delivery-sign-secret";

	it("signs a token that verifyViewerToken accepts and whose claims are preserved", async () => {
		const exp = Math.floor(Date.now() / 1000) + 3600;
		const jwt = await signViewerToken({ sub: "transcode:vid1", aud: "prefix-a", typ: "transcode", exp }, secret);
		const payload = await verifyViewerToken(jwt, secret);
		expect(payload).not.toBeNull();
		expect(payload?.sub).toBe("transcode:vid1");
		expect(payload?.aud).toBe("prefix-a");
		expect(payload?.typ).toBe("transcode");
	});

	it("a token signed with another secret does NOT verify", async () => {
		const jwt = await signViewerToken({ sub: "u", exp: Math.floor(Date.now() / 1000) + 60 }, secret);
		expect(await verifyViewerToken(jwt, "other-secret")).toBeNull();
	});
});

describe("encryptForStorage / loadStorageKey", () => {
	it("stores the key hanging off the object's storage key and round-trips the plaintext", async () => {
		const bucket = memoryBucket();
		const objectKey = "prefix-a/private/image/abc/foto.jpg";
		const plaintext = new TextEncoder().encode("contenido secreto".repeat(10));

		const { body: ciphertext, enc } = await encryptForStorage(bucket, objectKey, plaintext);
		expect(Array.from(ciphertext)).not.toEqual(Array.from(plaintext));

		// The key hung off the object's path (with a keyId).
		const storedPaths = [...bucket.store.keys()];
		expect(storedPaths).toHaveLength(1);
		expect(storedPaths[0].startsWith(`${objectKey}/`)).toBe(true);

		const meta = JSON.parse(enc) as { keyId: string; iv: string };
		const loaded = await loadStorageKey(bucket, objectKey, meta.keyId);
		expect(loaded).not.toBeNull();
		const iv = Uint8Array.from(atob(meta.iv), (c) => c.charCodeAt(0));
		const decrypted = await decryptChunk(ciphertext, (loaded as { key: CryptoKey }).key, iv, 0);
		expect(new TextDecoder().decode(decrypted)).toBe(new TextDecoder().decode(plaintext));
	});

	it("propagates customMetadata to the key (e.g. the binding override) and returns it on load", async () => {
		const bucket = memoryBucket();
		const objectKey = "video/vid1/hls/720p_000.ts";
		const { enc } = await encryptForStorage(bucket, objectKey, new Uint8Array([1, 2, 3]), {
			security: '{"sessionBinding":true}',
		});
		const keyId = (JSON.parse(enc) as { keyId: string }).keyId;
		const loaded = await loadStorageKey(bucket, objectKey, keyId);
		expect(loaded?.metadata?.security).toBe('{"sessionBinding":true}');
	});

	it("missing bucket → null", async () => {
		expect(await loadStorageKey(undefined, "x", "0")).toBeNull();
	});
});

describe("parseSecurityHeader", () => {
	it("parses valid JSON; undefined if missing or invalid", () => {
		expect(parseSecurityHeader('{"encrypt":true}')).toEqual({ encrypt: true });
		expect(parseSecurityHeader(undefined)).toBeUndefined();
		expect(parseSecurityHeader("")).toBeUndefined();
		expect(parseSecurityHeader("no-json")).toBeUndefined();
	});
});
