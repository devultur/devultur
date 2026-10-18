import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { memoryBucket } from "../exports-test-harness";
import { updateRequestState } from "../request-state";
import type { WorkerApp } from "../types";
import { upload } from "./upload";
import { newUploadPendingId, uploadPendingIdOf, uploadUrlFor } from "./upload-pending";

// Two callers of one Worker (storage prefix per caller, as an `external` auth layer would set it) that pick the SAME
// asset path. Credential-less requests carry no caller: only the pending id in the URL says which upload they act on.
const ASSET_PATH = "site/app.js";
const KEY = `public/asset/${ASSET_PATH}`;

function setup() {
	const kvEntries = new Map<string, string>();
	const bucket = memoryBucket();
	const env = {
		MEDIA_BUCKET: bucket,
		MEDIA_KV: {
			get: async (kvKey: string) => kvEntries.get(kvKey) ?? null,
			put: async (kvKey: string, value: string) => void kvEntries.set(kvKey, value),
			delete: async (kvKey: string) => void kvEntries.delete(kvKey),
		},
	} as unknown as WorkerApp["Bindings"];
	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		const caller = context.req.header("x-caller");
		updateRequestState(context, {
			storagePrefix: caller ? `${caller}/` : "",
			...(caller ? { access: { authenticated: true } } : {}),
		});
		if (caller) context.req.raw.headers.set("Authorization", `Bearer ${caller}`);
		await next();
	});
	app.route("/v1/upload", upload);

	const send = (path: string, init: RequestInit = {}) => app.request(`https://media.example${path}`, init, env);
	const createAsset = async (caller: string) => {
		const res = await send("/v1/upload", {
			method: "POST",
			headers: { "x-caller": caller, "Content-Type": "application/json" },
			body: JSON.stringify({ path: ASSET_PATH, contentType: "text/javascript", visibility: "public", overwrite: true }),
		});
		return ((await res.json()) as { uploadUrl: string }).uploadUrl;
	};
	const putBytes = (url: string, body: string, headers: Record<string, string> = {}) =>
		send(url, { method: "PUT", body, headers: { "Content-Type": "text/javascript", ...headers } });
	return { send, createAsset, putBytes, bucket, kvEntries };
}

describe("pending id", () => {
	it("is 128 random bits in base64url, and only a well-formed one is read from a URL", () => {
		const id = newUploadPendingId();
		expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(newUploadPendingId()).not.toBe(id);
		expect(uploadPendingIdOf(uploadUrlFor(KEY, id))).toBe(id);
		expect(uploadPendingIdOf(`https://media.example${uploadUrlFor(KEY, id)}&multipart=create`)).toBe(id);
		expect(uploadPendingIdOf(`/v1/upload/${KEY}`)).toBeUndefined();
		expect(uploadPendingIdOf(`/v1/upload/${KEY}?u=../x`)).toBeNull();
	});
});

describe("two callers uploading to the same asset path", () => {
	it("a second caller's POST cannot redirect the first caller's PUT into its own storage", async () => {
		const { createAsset, putBytes, bucket } = setup();
		const victimUrl = await createAsset("caller-b");
		const attackerUrl = await createAsset("caller-a");

		expect((await putBytes(victimUrl, "victim bytes")).status).toBe(200);
		expect(bucket.objects.has(`caller-b/${KEY}`)).toBe(true);
		expect(bucket.objects.has(`caller-a/${KEY}`)).toBe(false);

		// The attacker's own URL still writes only its own object.
		expect((await putBytes(attackerUrl, "attacker bytes")).status).toBe(200);
		expect(bucket.objects.has(`caller-a/${KEY}`)).toBe(true);
	});

	it("a second caller's POST does not break the first caller's in-flight multipart (no DoS)", async () => {
		const { createAsset, send, kvEntries } = setup();
		const victimUrl = await createAsset("caller-b");
		const created = await send(`${victimUrl}&multipart=create`, { method: "POST", body: JSON.stringify({ size: 10 }) });
		const { uploadId } = (await created.json()) as { uploadId: string };

		await createAsset("caller-a");
		// The attacker cannot reach the victim's session through the bare key, nor learn its uploadId.
		const hijack = await send(`/v1/upload/${KEY}?multipart=create`, {
			method: "POST",
			body: JSON.stringify({ size: 10 }),
		});
		expect(hijack.status).toBe(404);
		expect(JSON.stringify(await hijack.json())).not.toContain(uploadId);

		const victimPending = [...kvEntries.values()].find((value) => value.includes(uploadId));
		expect(JSON.parse(victimPending ?? "{}")).toMatchObject({ storageKey: `caller-b/${KEY}` });
		const retried = await send(`${victimUrl}&multipart=create`, { method: "POST", body: JSON.stringify({ size: 10 }) });
		expect(await retried.json()).toMatchObject({ uploadId });
	});

	it("an authenticated caller presenting another caller's upload URL gets 404", async () => {
		const { createAsset, putBytes, bucket } = setup();
		const victimUrl = await createAsset("caller-b");
		const res = await putBytes(victimUrl, "attacker bytes", { "x-caller": "caller-a" });
		expect(res.status).toBe(404);
		expect(bucket.objects.size).toBe(0);
	});
});
