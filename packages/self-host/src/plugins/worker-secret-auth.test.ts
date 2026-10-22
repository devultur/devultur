import { describe, expect, it } from "vitest";
import { memoryBucket, SIGN_SECRET } from "../exports-test-harness";
import { createWorker, type WorkerPlugin } from "../index";
import { withSignature } from "../test-fixtures";
import { isOpenRoute } from "./worker-secret-auth";
import { TEST_WORKER_SECRET, WORKER_SECRETS, withWorkerAuth } from "./worker-secret-auth-test-env";

function memoryKv() {
	const entries = new Map<string, string>();
	return {
		entries,
		get: async (key: string) => entries.get(key) ?? null,
		put: async (key: string, value: string) => void entries.set(key, value),
		delete: async (key: string) => void entries.delete(key),
	};
}

function setup(options: { secrets?: Record<string, string>; plugins?: WorkerPlugin[] } = {}) {
	const mediaBucket = memoryBucket();
	const kv = memoryKv();
	const env = {
		...(options.secrets ?? WORKER_SECRETS),
		MEDIA_BUCKET: mediaBucket,
		MEDIA_KV: kv,
		DELIVERY_SIGN_SECRET: SIGN_SECRET,
	};
	const app = createWorker(options.plugins ? { plugins: options.plugins } : undefined);
	const send = (path: string, init: RequestInit = {}) =>
		app.request(`https://media.example${path}`, init, env as never, { waitUntil() {} } as never);
	const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
		send(path, {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "Content-Type": "application/json", ...headers },
		});
	return { send, postJson, mediaBucket, kv };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const PROTECTED_ROUTES: Array<[method: string, path: string]> = [
	["POST", "/v1/upload"],
	["DELETE", "/v1/media/public/image/abc/photo.png"],
	["DELETE", "/v1/media/videos/vid1"],
	["GET", "/v1/assets"],
	["POST", "/v1/transcode"],
	["GET", "/v1/transcode/job-1"],
	["POST", "/v1/captions"],
	["GET", "/v1/captions/transcript-1"],
	["POST", "/v1/token"],
	["POST", "/v1/token/upload"],
	["POST", "/v1/token/download"],
	["POST", "/v1/webhooks-not-a-webhook"],
	["GET", "/v1/unknown"],
];

describe("isOpenRoute", () => {
	it("opens health, beacons, delivery, download links and webhooks", () => {
		expect(isOpenRoute("GET", "/health")).toBe(true);
		expect(isOpenRoute("POST", "/v1/metrics/playback")).toBe(true);
		expect(isOpenRoute("GET", "/v1/media/public/image/abc/photo.png")).toBe(true);
		expect(isOpenRoute("HEAD", "/v1/media/private/file/abc/doc.pdf")).toBe(true);
		expect(isOpenRoute("GET", "/v1/download/link-1")).toBe(true);
		expect(isOpenRoute("POST", "/v1/webhooks/transcode")).toBe(true);
		expect(isOpenRoute("OPTIONS", "/v1/upload")).toBe(true);
	});

	it("keeps writes and control routes closed", () => {
		for (const [method, path] of PROTECTED_ROUTES) expect(isOpenRoute(method, path)).toBe(false);
		expect(isOpenRoute("POST", "/health")).toBe(false);
		expect(isOpenRoute("GET", "/v1/webhooks/transcode")).toBe(false);
	});
});

describe("createWorker() control routes", () => {
	it.each(PROTECTED_ROUTES)("%s %s answers 401 without a bearer", async (method, path) => {
		const res = await setup().send(path, { method });
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ code: "unauthorized" });
	});

	it.each(PROTECTED_ROUTES)("%s %s answers 401 with a wrong bearer", async (method, path) => {
		const res = await setup().send(path, { method, headers: bearer(`${TEST_WORKER_SECRET}x`) });
		expect(res.status).toBe(401);
	});

	it.each(PROTECTED_ROUTES)("%s %s answers 503 when WORKER_AUTH_SECRET is unset", async (method, path) => {
		const res = await setup({ secrets: {} }).send(path, { method, headers: bearer(TEST_WORKER_SECRET) });
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ code: "worker_auth_secret_missing" });
	});

	it("lets the backend through with the worker secret", async () => {
		const res = await setup().postJson("/v1/token", { userId: "u1" }, bearer(TEST_WORKER_SECRET));
		expect(res.status).toBe(200);
		expect(await res.json()).toHaveProperty("token");
	});
});

describe("createWorker() open routes", () => {
	it("serves /health and accepts playback beacons without any secret", async () => {
		const worker = setup({ secrets: {} });
		expect((await worker.send("/health")).status).toBe(200);
		expect((await worker.send("/v1/metrics/playback", { method: "POST", body: "{}" })).status).toBe(204);
	});

	it("delivers public media tokenless, and private media only with a viewer token or the worker secret", async () => {
		const worker = setup();
		await worker.mediaBucket.put("public/image/abc/photo.png", "png", { httpMetadata: { contentType: "image/png" } });
		await worker.mediaBucket.put("private/file/abc/doc.pdf", "pdf", {
			httpMetadata: { contentType: "application/pdf" },
		});

		expect((await worker.send("/v1/media/public/image/abc/photo.png")).status).toBe(200);
		expect((await worker.send("/v1/media/private/file/abc/doc.pdf")).status).toBe(401);

		const owner = await worker.send("/v1/media/private/file/abc/doc.pdf", { headers: bearer(TEST_WORKER_SECRET) });
		expect(owner.status).toBe(200);

		const issued = await worker.postJson("/v1/token", { userId: "u1" }, bearer(TEST_WORKER_SECRET));
		const { token } = (await issued.json()) as { token: string };
		expect((await worker.send(`/v1/media/private/file/abc/doc.pdf?token=${token}`)).status).toBe(200);
	});

	it("leaves download-link redemption to the link id", async () => {
		const res = await setup({ secrets: {} }).send("/v1/download/link-1");
		expect([401, 503]).not.toContain(res.status);
	});

	it("rejects transcode webhooks when TRANSCODE_WEBHOOK_SECRET is unset (fail-closed)", async () => {
		const worker = setup({ secrets: { WORKER_AUTH_SECRET: TEST_WORKER_SECRET } });
		const res = await worker.postJson("/v1/webhooks/transcode", { event: "transcode.complete", videoId: "vid1" });
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ code: "webhook_secret_missing" });
	});

	it("rejects transcode webhooks with a wrong secret", async () => {
		const res = await setup().postJson(
			"/v1/webhooks/transcode",
			{ event: "transcode.complete", videoId: "vid1" },
			bearer("wrong"),
		);
		expect(res.status).toBe(401);
	});
});

describe("upload URLs are capabilities", () => {
	async function createUpload(worker: ReturnType<typeof setup>) {
		const res = await worker.postJson(
			"/v1/upload",
			{ filename: "photo.png", contentType: "image/png", visibility: "public" },
			bearer(TEST_WORKER_SECRET),
		);
		expect(res.status).toBe(200);
		return (await res.json()) as { key: string; uploadUrl: string };
	}

	it("accepts the bytes of an upload that an authenticated POST created, without a credential", async () => {
		const worker = setup();
		const { key, uploadUrl } = await createUpload(worker);
		const res = await worker.send(uploadUrl, {
			method: "PUT",
			body: withSignature("image/png", "png"),
			headers: { "Content-Type": "image/png" },
		});
		expect(res.status).toBe(200);
		expect(worker.mediaBucket.objects.has(key)).toBe(true);
	});

	it("refuses a credential-less PUT to a key nobody created", async () => {
		const worker = setup();
		const res = await worker.send("/v1/upload/public/image/evil/owned.png", {
			method: "PUT",
			body: "x",
			headers: { "Content-Type": "image/png", ...bearer("wrong") },
		});
		expect(res.status).toBe(404);
		expect(worker.mediaBucket.objects.size).toBe(0);
	});

	it("refuses a credential-less PUT to a pending asset path without its pending id", async () => {
		const worker = setup();
		const created = await worker.postJson(
			"/v1/upload",
			{ path: "site/app.js", contentType: "text/javascript", visibility: "public" },
			bearer(TEST_WORKER_SECRET),
		);
		const { key, uploadUrl } = (await created.json()) as { key: string; uploadUrl: string };
		expect(key).toBe("public/asset/site/app.js");

		const pendingQuery = new URL(uploadUrl, "https://media.example").search;
		for (const forged of [`/v1/upload/${key}`, `/v1/upload/${key}?u=AAAAAAAAAAAAAAAAAAAAAA`, `/v1/upload/${key}?u=`]) {
			const res = await worker.send(forged, {
				method: "PUT",
				body: "evil",
				headers: { "Content-Type": "text/javascript" },
			});
			expect(res.status, forged).toBe(404);
		}
		// The id only works for the URL it was issued for.
		const elsewhere = await worker.send(`/v1/upload/public/asset/site/other.js${pendingQuery}`, {
			method: "PUT",
			body: "evil",
			headers: { "Content-Type": "text/javascript" },
		});
		expect(elsewhere.status).toBe(404);
		expect(worker.mediaBucket.objects.size).toBe(0);

		const res = await worker.send(uploadUrl, {
			method: "PUT",
			body: "ok",
			headers: { "Content-Type": "text/javascript" },
		});
		expect(res.status).toBe(200);
		expect(worker.mediaBucket.objects.has(key)).toBe(true);
	});

	it("returns an upload URL that carries a fresh 128-bit pending id, and keys the pending by it", async () => {
		const worker = setup();
		const create = async () => {
			const res = await worker.postJson(
				"/v1/upload",
				{ path: "site/app.js", contentType: "text/javascript", visibility: "public", overwrite: true },
				bearer(TEST_WORKER_SECRET),
			);
			return ((await res.json()) as { uploadUrl: string }).uploadUrl;
		};
		const [first, second] = [await create(), await create()];
		expect(first).toMatch(/^\/v1\/upload\/public\/asset\/site\/app\.js\?u=[A-Za-z0-9_-]{22}$/);
		expect(second).not.toBe(first);
		// Dos POST a la misma key no se pisan: cada uno tiene su pending.
		expect([...worker.kv.entries.keys()].filter((kvKey) => kvKey.startsWith("upload-pending:"))).toHaveLength(2);
		expect(worker.kv.entries.has("upload-pending:public/asset/site/app.js")).toBe(false);
	});

	it("lets the transcode runner upload derived assets with the worker secret", async () => {
		const worker = setup();
		const putRes = await worker.send("/v1/upload/public/video/vid1/hls/playlist.m3u8", {
			method: "PUT",
			body: "#EXTM3U",
			headers: { "Content-Type": "application/vnd.apple.mpegurl", ...bearer(TEST_WORKER_SECRET) },
		});
		expect(putRes.status).toBe(200);

		const derivedKey = "/v1/upload/public/video/vid1/mp4/1080p.mp4?multipart=create";
		const body = { size: 10, contentType: "video/mp4" };
		expect((await worker.postJson(derivedKey, body, bearer("wrong"))).status).toBe(404);
		expect((await worker.postJson(derivedKey, body, bearer(TEST_WORKER_SECRET))).status).toBe(200);
	});

	it("accepts an upload token on POST /v1/upload, and nowhere else", async () => {
		const worker = setup();
		const issued = await worker.postJson("/v1/token/upload", { prefix: "exports/" }, bearer(TEST_WORKER_SECRET));
		const { token } = (await issued.json()) as { token: string };

		const created = await worker.postJson(
			"/v1/upload",
			{ path: "exports/run-1/report.zip", contentType: "application/zip" },
			bearer(token),
		);
		expect(created.status).toBe(200);
		const outside = await worker.postJson(
			"/v1/upload",
			{ path: "other/report.zip", contentType: "application/zip" },
			bearer(token),
		);
		expect(outside.status).toBe(403);

		expect((await worker.postJson("/v1/token", { userId: "u1" }, bearer(token))).status).toBe(401);
		expect((await worker.send("/v1/assets", { headers: bearer(token) })).status).toBe(401);
	});
});

// An auth plugin that lets every request through: what a plugin of your own replaces `workerSecretAuth()` with.
const openAuth: WorkerPlugin = { name: "open-auth", middleware: { auth: [async (_context, next) => next()] } };

describe("an auth plugin of your own", () => {
	it("replaces the worker-secret check", async () => {
		const worker = setup({ secrets: {}, plugins: [openAuth] });
		const res = await worker.postJson("/v1/token", { userId: "u1" });
		expect(res.status).toBe(200);
	});

	it("still requires the webhook secret", async () => {
		const worker = setup({ secrets: {}, plugins: [openAuth] });
		const res = await worker.send("/v1/webhooks/transcode", withWorkerAuth({ method: "POST", body: "{}" }));
		expect(res.status).toBe(503);
	});
});

describe("createWorker() without an auth plugin", () => {
	it("fails closed at startup", () => {
		expect(() => createWorker({ plugins: [] })).toThrow(/no plugin authenticates requests/);
	});

	it("refuses two plugins with the same name", () => {
		expect(() => createWorker({ plugins: [openAuth, openAuth] })).toThrow(/two plugins are named/);
	});
});
