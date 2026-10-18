import { createWorker, credentialPolicy, downloadLinks } from "@devultur/self-host";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { jwtAuth } from "./jwt-auth";
import { rateLimit } from "./rate-limit";
import { type UsageRecord, usageLog } from "./usage-log";

const JWT_SECRET = "jwt-secret";
const WORKER_AUTH_SECRET = "worker-secret";
const image = { httpMetadata: { contentType: "image/png" }, size: 4, httpEtag: '"e"', body: "data" };

function setup(options: { allowed?: boolean } = {}) {
	const records: UsageRecord[] = [];
	const waits: Promise<unknown>[] = [];
	const worker = createWorker({
		plugins: [
			rateLimit({ binding: "RATE_LIMITER" }),
			jwtAuth({ issuer: "https://auth.example", storagePrefix: (claims) => (claims.app ? `${claims.app}/` : null) }),
			credentialPolicy(),
			downloadLinks(),
			usageLog({ sink: { record: (record) => void records.push(record) } }),
		],
	});
	const env = {
		JWT_SECRET,
		WORKER_AUTH_SECRET,
		DELIVERY_SIGN_SECRET: "delivery-secret",
		RATE_LIMITER: { limit: async () => ({ success: options.allowed ?? true }) },
		MEDIA_BUCKET: { get: async (key: string) => (key === "web/public/image/i1/a.png" ? image : null) },
	};
	const executionCtx = {
		waitUntil: (promise: Promise<unknown>) => void waits.push(promise),
		passThroughOnException() {},
	};
	const send = (path: string, init: RequestInit = {}) =>
		worker.request(`https://media.example${path}`, init, env, executionCtx as never);
	return { send, records, settle: () => Promise.all(waits) };
}

const tokenRequest = (authorization?: string) => ({
	method: "POST",
	headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
	body: JSON.stringify({ userId: "u1" }),
});

const claimsOf = (token: string) => JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));

describe("jwt-auth", () => {
	it("authenticates a token of your issuer under the storage prefix its claim names", async () => {
		const jwt = await sign({ iss: "https://auth.example", app: "web", exp: Date.now() / 1000 + 60 }, JWT_SECRET);
		const res = await setup().send("/v1/token", tokenRequest(`Bearer ${jwt}`));
		expect(res.status).toBe(200);
		expect(claimsOf(((await res.json()) as { token: string }).token).aud).toBe("web");
	});

	it("refuses a token of another issuer, one without a prefix and no token at all", async () => {
		const { send } = setup();
		const foreign = await sign({ iss: "https://other.example", app: "web" }, JWT_SECRET);
		const unscoped = await sign({ iss: "https://auth.example" }, JWT_SECRET);
		for (const authorization of [`Bearer ${foreign}`, `Bearer ${unscoped}`, undefined]) {
			expect((await send("/v1/token", tokenRequest(authorization))).status).toBe(401);
		}
	});

	it("still accepts the Worker secret, the runner's credential", async () => {
		expect((await setup().send("/v1/token", tokenRequest(`Bearer ${WORKER_AUTH_SECRET}`))).status).toBe(200);
	});
});

describe("rate-limit", () => {
	it("answers 429 over the limit, before auth", async () => {
		const res = await setup({ allowed: false }).send("/v1/token", tokenRequest());
		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("60");
	});
});

describe("usage-log", () => {
	it("records the bytes a delivery streamed, under the request's storage prefix", async () => {
		const { send, records, settle } = setup();
		const jwt = await sign({ iss: "https://auth.example", app: "web" }, JWT_SECRET);
		const res = await send("/v1/media/public/image/i1/a.png", { headers: { Authorization: `Bearer ${jwt}` } });
		expect(await res.text()).toBe("data");
		await settle();
		expect(records).toEqual([
			expect.objectContaining({ storagePrefix: "web/", key: "public/image/i1/a.png", status: 200, bytes: 4 }),
		]);
	});
});
