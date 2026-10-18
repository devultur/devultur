import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { SERVICE_TOKEN_TYPE, signViewerToken } from "../helpers";
import { updateRequestState } from "../request-state";
import type { WorkerApp } from "../types";
import { media } from "./media";
import { viewerTokenClaimRejection } from "./viewer-token-claims";

// The delivery gate enforces the claims of a viewer token itself (`aud`, `res`, `scope`), so a token never opens media
// outside what it was issued for, whatever auth plugin runs in front.

const SECRET = "delivery-sign-secret";
const STORAGE_PREFIX = "prefix-a/";
const PRIVATE_KEY = "private/image/clientA/photo.jpg";

const fakeObject = {
	httpMetadata: { contentType: "image/jpeg" },
	size: 3,
	httpEtag: '"e"',
	body: "img",
	async text() {
		return "img";
	},
};

function request(key: string, options: { token?: string; isOwnerAccess?: boolean } = {}) {
	const bucket = { get: async (fullKey: string) => (fullKey.startsWith(STORAGE_PREFIX) ? fakeObject : null) };
	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		updateRequestState(context, { storagePrefix: STORAGE_PREFIX });
		if (options.isOwnerAccess) updateRequestState(context, { access: { trustedRead: true } });
		await next();
	});
	app.route("/v1/media", media);
	const env = { MEDIA_BUCKET: bucket, DELIVERY_SIGN_SECRET: SECRET } as unknown as WorkerApp["Bindings"];
	const query = options.token ? `?token=${options.token}` : "";
	return app.request(`http://worker/v1/media/${key}${query}`, {}, env);
}

function token(claims: Record<string, unknown>) {
	const exp = Math.floor(Date.now() / 1000) + 3600;
	return signViewerToken({ sub: "u", exp, ...claims }, SECRET);
}

describe("private delivery gate: viewer token claims", () => {
	it("serves a token issued for this storage prefix, path prefix and scope", async () => {
		const res = await request(PRIVATE_KEY, {
			token: await token({ aud: "prefix-a", res: "image/clientA/", scope: "media:read" }),
		});
		expect(res.status).toBe(200);
	});

	it("serves a token without those claims (unscoped issuance)", async () => {
		expect((await request(PRIVATE_KEY, { token: await token({}) })).status).toBe(200);
	});

	it("serves a token with the `*` scope among others", async () => {
		const res = await request(PRIVATE_KEY, { token: await token({ aud: "prefix-a", scope: "media:write *" }) });
		expect(res.status).toBe(200);
	});

	it.each([
		["another storage prefix's `aud`", { aud: "prefix-b" }, "audience"],
		["an `aud` that only shares a prefix", { aud: "prefix" }, "audience"],
		["a nested `aud`", { aud: "prefix-a/key_1" }, "audience"],
		["a non-string `aud`", { aud: 1 }, "audience"],
		["a `res` outside the requested key", { aud: "prefix-a", res: "image/clientB/" }, "resource"],
		["a `res` that only shares characters", { res: "image/client/" }, "resource"],
		["a non-string `res`", { res: ["image/"] }, "resource"],
		["a scope without media:read", { aud: "prefix-a", scope: "media:write" }, "scope"],
		["an empty scope", { scope: "" }, "scope"],
		["a non-string scope", { scope: ["media:read"] }, "scope"],
	])("rejects %s with a generic 403 and logs why", async (_label, claims, reason) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const res = await request(PRIVATE_KEY, { token: await token(claims) });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "Token rejected", code: "token_rejected" });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(`(${reason})`));
		warn.mockRestore();
	});

	it("still answers 401 for a token that does not verify", async () => {
		const forged = await signViewerToken({ sub: "u", aud: "prefix-a" }, "other-secret");
		expect((await request(PRIVATE_KEY, { token: forged })).status).toBe(401);
	});

	it("lets the transcode service token read the raw video of its own storage prefix", async () => {
		const serviceToken = await token({
			sub: "transcode:vid1",
			typ: SERVICE_TOKEN_TYPE,
			scope: "media:read",
			bind: { sessionBinding: false, ipBinding: false },
			aud: "prefix-a",
		});
		expect((await request("private/image/vid1/raw.jpg", { token: serviceToken })).status).toBe(200);
		const foreign = await token({ typ: SERVICE_TOKEN_TYPE, scope: "media:read", aud: "prefix-b" });
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect((await request("private/image/vid1/raw.jpg", { token: foreign })).status).toBe(403);
		vi.restoreAllMocks();
	});

	it("does not check token claims on owner access", async () => {
		expect((await request(PRIVATE_KEY, { isOwnerAccess: true })).status).toBe(200);
	});

	it("ignores token claims on public media", async () => {
		const res = await request("public/image/clientA/photo.jpg", { token: await token({ aud: "prefix-b" }) });
		expect(res.status).toBe(200);
	});
});

describe("viewerTokenClaimRejection", () => {
	it("compares `aud` with the storage prefix without its trailing slash", () => {
		expect(viewerTokenClaimRejection({ aud: "prefix-a" }, { storagePrefix: "prefix-a/", key: PRIVATE_KEY })).toBeNull();
		expect(viewerTokenClaimRejection({ aud: "prefix-a" }, { storagePrefix: "prefix-a", key: PRIVATE_KEY })).toBeNull();
	});

	it("rejects an `aud` when the request has no storage prefix", () => {
		for (const storagePrefix of ["", undefined]) {
			expect(viewerTokenClaimRejection({ aud: "prefix-a" }, { storagePrefix, key: PRIVATE_KEY })).toMatchObject({
				code: "token_rejected",
				reason: "audience",
			});
		}
	});

	it("rejects a `res` for a key without a visibility segment", () => {
		expect(viewerTokenClaimRejection({ res: "image/" }, { storagePrefix: "", key: "image/a.jpg" })).toMatchObject({
			code: "token_rejected",
			reason: "resource",
		});
	});
});
