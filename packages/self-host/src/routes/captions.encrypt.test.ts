import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptForStorage } from "../helpers";
import { updateRequestState } from "../request-state";
import type { WorkerApp } from "../types";
import { captions } from "./captions";

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

// In-memory R2 bucket (put/get with customMetadata + arrayBuffer) for key material.
function memoryBucket() {
	const store = new Map<string, { body: Uint8Array; customMetadata?: Record<string, string> }>();
	return {
		put: async (key: string, body: ArrayBuffer | Uint8Array, options?: { customMetadata?: Record<string, string> }) => {
			store.set(key, { body: new Uint8Array(body as ArrayBuffer), customMetadata: options?.customMetadata });
		},
		get: async (key: string) => {
			const hit = store.get(key);
			return hit ? { arrayBuffer: async () => hit.body.buffer, customMetadata: hit.customMetadata } : null;
		},
	} as unknown as R2Bucket;
}

describe("captions L4: decrypts the encrypted raw before transcribing", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("Groq receives the PLAINTEXT of the raw, not the ciphertext", async () => {
		const plaintext = new TextEncoder().encode("PLAINTEXT-AUDIO-BYTES-".repeat(8));
		const keysBucket = memoryBucket();
		// storagePrefix "" → fullKey = body.key; the raw's key hangs off `${fullKey}/${keyId}`.
		const rawKey = "private/video/vid1/raw/clip.mp4";
		const { body: ciphertext, enc } = await encryptForStorage(keysBucket, rawKey, plaintext);
		expect(Array.from(ciphertext)).not.toEqual(Array.from(plaintext)); // sanity: it's encrypted.

		const mediaBucket = {
			get: async () => ({ body: streamOf(ciphertext), customMetadata: { enc } }),
			head: async () => null,
			put: async () => {},
		} as unknown as R2Bucket;

		let receivedAudio: Uint8Array | null = null;
		vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
			if (String(url).includes("groq")) {
				const file = (init?.body as FormData).get("file") as Blob;
				receivedAudio = new Uint8Array(await file.arrayBuffer());
				return new Response(
					JSON.stringify({
						task: "transcribe",
						language: "es",
						duration: 1,
						text: "hola",
						segments: [],
						words: [{ word: "hola", start: 0, end: 1 }],
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("ok"); // webhook or other
		});

		const app = new Hono<WorkerApp>();
		app.use("*", async (context, next) => {
			updateRequestState(context, { storagePrefix: "" });
			updateRequestState(context, { runnerCredential: "" });
			await next();
		});
		app.route("/v1/captions", captions);

		const env = {
			MEDIA_BUCKET: mediaBucket,
			KEYS_BUCKET: keysBucket,
			GROQ_API_KEY: "g",
			MISTRAL_API_KEY: "m",
			MEDIA_KV: { put: async () => {}, get: async () => null },
		} as unknown as WorkerApp["Bindings"];

		const res = await app.request(
			"http://worker/v1/captions",
			{
				method: "POST",
				body: JSON.stringify({ key: rawKey, locales: ["es-CO"] }),
				headers: { "Content-Type": "application/json" },
			},
			env,
		);

		expect(res.status).toBe(200);
		expect(receivedAudio).not.toBeNull();
		// The fix's proof: Groq received the decrypted plaintext, not R2's ciphertext.
		expect(new TextDecoder().decode(receivedAudio as unknown as Uint8Array)).toBe(new TextDecoder().decode(plaintext));
	});
});
