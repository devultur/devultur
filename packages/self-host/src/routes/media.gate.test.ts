import { computeFingerprint } from "@devultur/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { updateRequestState } from "../request-state";
import type { WorkerApp } from "../types";
import { media } from "./media";

const SECRET = "delivery-sign-secret";

// Signs a test viewer token with the same logic as /v1/token (HMAC-SHA256).
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

// R2 mock: any key containing `/image/` exists; everything else is 404.
const fakeObject = {
	httpMetadata: { contentType: "image/jpeg" },
	size: 3,
	httpEtag: '"e"',
	body: "img",
	async text() {
		return "img";
	},
};

function request(path: string, token?: string, headers?: Record<string, string>) {
	const bucket = { get: async (key: string) => (key.includes("/image/") ? fakeObject : null) };
	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		updateRequestState(context, { storagePrefix: "" });
		await next();
	});
	app.route("/v1/media", media);
	const env = { MEDIA_BUCKET: bucket, DELIVERY_SIGN_SECRET: SECRET } as unknown as WorkerApp["Bindings"];
	const url = `http://worker${path}${token ? `?token=${token}` : ""}`;
	return app.request(url, { headers }, env);
}

const now = () => Math.floor(Date.now() / 1000);
const validToken = () => signToken({ sub: "u", exp: now() + 3600 }, SECRET);
const expiredToken = () => signToken({ sub: "u", exp: now() - 10 }, SECRET);

// Token with L3 binding (nonce + fp/fpip + policy). The fingerprint is tied to the client's `sessionSecret`.
async function boundToken(opts: { sessionSecret: string; ip: string; sessionBinding: boolean; ipBinding: boolean }) {
	const userId = "u";
	const nonce = "nonce-1";
	return signToken(
		{
			sub: userId,
			nonce,
			fp: await computeFingerprint(userId, opts.sessionSecret, nonce),
			fpip: await computeFingerprint(userId, opts.sessionSecret, nonce, opts.ip),
			bind: { sessionBinding: opts.sessionBinding, ipBinding: opts.ipBinding },
			exp: now() + 3600,
		},
		SECRET,
	);
}

describe("media gate (visibility)", () => {
	it("public: serves without a token (200) and is cacheable in the CDN", async () => {
		const res = await request("/v1/media/public/image/abc/foto.jpg");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toContain("public");
	});

	it("private without a token → 401 (not 500)", async () => {
		const res = await request("/v1/media/private/image/abc/foto.jpg");
		expect(res.status).toBe(401);
	});

	it("private with a malformed or invalid token → 401", async () => {
		expect((await request("/v1/media/private/image/abc/foto.jpg", "not-a-jwt")).status).toBe(401);
		expect((await request("/v1/media/private/image/abc/foto.jpg", await signToken({ sub: "u" }, "other"))).status).toBe(
			401,
		);
	});

	it("private with an expired token → 401", async () => {
		const res = await request("/v1/media/private/image/abc/foto.jpg", await expiredToken());
		expect(res.status).toBe(401);
	});

	it("private with a valid token (no binding, backward-compat) → 200", async () => {
		const res = await request("/v1/media/private/image/abc/foto.jpg", await validToken());
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toContain("private");
	});
});

describe("media gate (L3 binding by session secret)", () => {
	const S = "browser-session-secret";
	const H = "X-Devultur-Session";
	const IP = "1.2.3.4";
	const path = "/v1/media/private/image/abc/foto.jpg";

	it("session binding: same secret (header) → 200", async () => {
		const token = await boundToken({ sessionSecret: S, ip: IP, sessionBinding: true, ipBinding: false });
		const res = await request(path, token, { [H]: S });
		expect(res.status).toBe(200);
	});

	it("session binding: different secret → 401 session_mismatch", async () => {
		const token = await boundToken({ sessionSecret: S, ip: IP, sessionBinding: true, ipBinding: false });
		const res = await request(path, token, { [H]: "other-secret" });
		expect(res.status).toBe(401);
		expect(((await res.json()) as { code?: string }).code).toBe("session_mismatch");
	});

	it("session binding: WITHOUT header (leaked URL) → 401 session_mismatch", async () => {
		const token = await boundToken({ sessionSecret: S, ip: IP, sessionBinding: true, ipBinding: false });
		const res = await request(path, token); // only the token in the URL, no header
		expect(res.status).toBe(401);
		expect(((await res.json()) as { code?: string }).code).toBe("session_mismatch");
	});

	it("session binding does NOT check IP: same secret, different IP → 200", async () => {
		const token = await boundToken({ sessionSecret: S, ip: IP, sessionBinding: true, ipBinding: false });
		const res = await request(path, token, { [H]: S, "CF-Connecting-IP": "9.9.9.9" });
		expect(res.status).toBe(200);
	});

	it("ip binding: same secret + same IP → 200", async () => {
		const token = await boundToken({ sessionSecret: S, ip: IP, sessionBinding: true, ipBinding: true });
		const res = await request(path, token, { [H]: S, "CF-Connecting-IP": IP });
		expect(res.status).toBe(200);
	});

	it("ip binding: same secret, different IP → 401 session_mismatch", async () => {
		const token = await boundToken({ sessionSecret: S, ip: IP, sessionBinding: true, ipBinding: true });
		const res = await request(path, token, { [H]: S, "CF-Connecting-IP": "9.9.9.9" });
		expect(res.status).toBe(401);
		expect(((await res.json()) as { code?: string }).code).toBe("session_mismatch");
	});
});
