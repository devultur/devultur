import { MediaEventName, sha256Hex } from "@devultur/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryBucket, SIGN_SECRET } from "../../self-host/src/exports-test-harness";
import { createWorker } from "../../self-host/src/index";
import type { TranscodeContainerNamespace } from "../../self-host/src/transcode/cloudflare";
import { memoryDb } from "./memory-db";

// Contract test: the component's REAL action handlers (public.ts) and webhook route (http.ts) against an in-memory
// `createWorker()` with the default plugins. Only the Convex runtime is stubbed: the function builders return their
// definitions, `ctx.runQuery` / `ctx.runMutation` are spies that run the component's own queries and mutations
// against an in-memory database, `ctx.scheduler` is a spy, and the transcode runner is a fake container that records
// the launch instead of running FFmpeg (the runner's callback is simulated below).
// It lives outside `src` because it imports the Worker's source and test harness, which the published package must
// not (see scripts/oss-leak-guard.test.ts).

const WORKER_URL = "https://media.example";
const CONVEX_SITE_URL = "https://app.convex.site/devultur";
const WORKER_AUTH_SECRET = "worker-auth-secret";
// Deliberately different from WORKER_AUTH_SECRET: the component must only ever need the latter.
const TRANSCODE_WEBHOOK_SECRET = "transcode-webhook-secret";
const TRANSCRIPTION_URL = "https://api.groq.com/";

type Handler = (ctx: unknown, args: unknown) => Promise<unknown>;
interface FunctionDefinition {
	args: Record<string, unknown>;
	handler: Handler;
}

const { componentEnv } = vi.hoisted(() => ({
	componentEnv: {} as { DEVULTUR_SECRET?: string; DEVULTUR_API_URL?: string },
}));

vi.mock("../src/component/_generated/server", () => {
	const definition = (fn: FunctionDefinition) => fn;
	return {
		env: componentEnv,
		action: definition,
		mutation: definition,
		query: definition,
		internalMutation: definition,
		httpAction: (handler: unknown) => handler,
	};
});
vi.mock("../src/component/_generated/api", () => {
	const references = new Proxy({}, { get: (_target, name) => `public.${String(name)}` });
	return { api: { public: references }, internal: { public: references } };
});

const component = (await import("../src/component/public")) as unknown as Record<string, FunctionDefinition>;
const { default: http } = await import("../src/component/http");

function memoryKv() {
	const entries = new Map<string, string>();
	return {
		entries,
		get: async (key: string, type?: string) => {
			const value = entries.get(key) ?? null;
			return type === "json" && value ? JSON.parse(value) : value;
		},
		put: async (key: string, value: string) => void entries.set(key, value),
		delete: async (key: string) => void entries.delete(key),
	};
}

function fakeTranscodeContainer() {
	const launches: Array<{ env: Record<string, string> }> = [];
	const namespace: TranscodeContainerNamespace = {
		idFromName: (name) => name as unknown as DurableObjectId,
		get: () => ({
			launch: async (request) => {
				launches.push(request);
				return { alreadyRunning: false };
			},
			cancel: async () => {},
		}),
	};
	return { namespace, launches };
}

interface WorkerCall {
	method: string;
	path: string;
	status: number;
}

interface WebhookDelivery {
	url: string;
	authorization: string | null;
	body: Record<string, unknown>;
	status: number;
}

/**
 * The self-hosted Worker plus the network between it, the component and the browser: `fetch` to the Worker's URL
 * goes to the in-memory app, `fetch` to the Convex site goes to the component's HTTP router (the Worker forwarding a
 * webhook), and anything else fails.
 */
function setup() {
	const mediaBucket = memoryBucket();
	const container = fakeTranscodeContainer();
	const env = {
		WORKER_AUTH_SECRET,
		TRANSCODE_WEBHOOK_SECRET,
		DELIVERY_SIGN_SECRET: SIGN_SECRET,
		MEDIA_BUCKET: mediaBucket,
		MEDIA_KV: memoryKv(),
		TRANSCODE_RUNNER: "cloudflare",
		TRANSCODE_CONTAINER: container.namespace,
		GROQ_API_KEY: "transcription-key",
	};
	// The transcription provider the captions route calls. Off by default: the network refuses it. When available,
	// it answers once `pending` settles, and resolves `requested` when the Worker calls it.
	const transcription = {
		isAvailable: false,
		pending: Promise.resolve(),
		requested: Promise.withResolvers<void>(),
	};
	const app = createWorker();
	const executionCtx = { waitUntil() {}, passThroughOnException() {} } as never;
	const workerCalls: WorkerCall[] = [];
	const webhookDeliveries: WebhookDelivery[] = [];
	const db = memoryDb();
	// `api.public.x` / `internal.public.x` are the strings "public.x" here (see the `_generated/api` mock).
	const runFunction = async (reference: string, args: unknown) => {
		const fn = component[reference.replace(/^public\./, "")];
		if (!fn) throw new Error(`component function ${reference} not found`);
		return fn.handler({ db }, args);
	};
	const runMutation = vi.fn(runFunction);

	const sendToWorker = (request: Request) => app.request(request, undefined, env as never, executionCtx);

	async function deliverToComponent(request: Request): Promise<Response> {
		const route = http.lookup(new URL(request.url).pathname.replace(/^\/devultur/, ""), "POST");
		if (!route) return new Response("No route", { status: 404 });
		const [handler] = route as unknown as [(ctx: unknown, request: Request) => Promise<Response>];
		return handler({ runMutation }, request);
	}

	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		if (request.url.startsWith(WORKER_URL)) {
			const response = await sendToWorker(request);
			const { pathname } = new URL(request.url);
			workerCalls.push({ method: request.method, path: pathname, status: response.status });
			return response;
		}
		if (request.url.startsWith(CONVEX_SITE_URL)) {
			const body = (await request.clone().json()) as Record<string, unknown>;
			const response = await deliverToComponent(request);
			webhookDeliveries.push({
				url: request.url,
				authorization: request.headers.get("Authorization"),
				body,
				status: response.status,
			});
			return response;
		}
		if (transcription.isAvailable && request.url.startsWith(TRANSCRIPTION_URL)) {
			transcription.requested.resolve();
			await transcription.pending;
			return Response.json({ language: "english", duration: 12, words: [{ word: "Hello.", start: 0, end: 1 }] });
		}
		throw new Error(`Unexpected fetch to ${request.url}`);
	});

	const ctx = {
		runQuery: vi.fn(runFunction),
		runMutation,
		scheduler: { runAfter: vi.fn(async () => {}) },
	};
	const run = (name: string, args: unknown) => {
		const fn = component[name];
		if (!fn) throw new Error(`component function ${name} not found`);
		return fn.handler(ctx, args);
	};
	/** A direct request to the Worker, as a browser or the transcode runner makes it. */
	const send = (path: string, init?: RequestInit) => sendToWorker(new Request(`${WORKER_URL}${path}`, init));

	/** The component's media record for `key`, as the app's queries read it. */
	const mediaRecord = (key: string) => runFunction("public.getMediaByKey", { key }) as Promise<Record<string, unknown>>;

	return {
		run,
		send,
		deliverToComponent,
		mediaBucket,
		container,
		workerCalls,
		webhookDeliveries,
		runMutation,
		mediaRecord,
		transcription,
	};
}

type Contract = ReturnType<typeof setup>;

async function uploadThroughComponent(contract: Contract, file: { filename: string; contentType: string }) {
	const created = (await contract.run("createUploadUrl", { ...file, visibility: "private" })) as {
		url: string;
		key: string;
	};
	const bytes = new TextEncoder().encode(`bytes of ${file.filename}`);
	// The browser PUTs to the URL the component returned (on the Worker's origin).
	const put = await fetch(created.url, { method: "PUT", body: bytes, headers: { "Content-Type": file.contentType } });
	return { ...created, bytes, put };
}

/** The transcode runner reports `transcode.complete` to the Worker, which forwards it to the component. */
async function completeTranscode(contract: Contract) {
	const videoId = contract.container.launches.at(-1)?.env.VIDEO_ID;
	const callback = await contract.send("/v1/webhooks/transcode", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${TRANSCODE_WEBHOOK_SECRET}` },
		body: JSON.stringify({
			event: MediaEventName.TRANSCODE_COMPLETE,
			videoId,
			duration: 12,
			playlistKey: "master.m3u8",
		}),
	});
	expect(callback.status).toBe(200);
}

beforeEach(() => {
	componentEnv.DEVULTUR_API_URL = WORKER_URL;
	componentEnv.DEVULTUR_SECRET = WORKER_AUTH_SECRET;
	vi.stubEnv("CONVEX_SITE_URL", CONVEX_SITE_URL);
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("@devultur/convex against a self-hosted Worker", () => {
	it("creates an upload URL whose PUT stores the bytes with a verified SHA-256", async () => {
		const contract = setup();
		const { url, key, bytes, put } = await uploadThroughComponent(contract, {
			filename: "doc.pdf",
			contentType: "application/pdf",
		});

		expect(url.startsWith(`${WORKER_URL}/v1/upload/`)).toBe(true);
		expect(put.status).toBe(200);
		expect(await put.json()).toMatchObject({ key, sha256: await sha256Hex(bytes), sha256Verified: true });
		expect(contract.mediaBucket.objects.has(key)).toBe(true);
	});

	it("issues a viewer token that unlocks private media, which is 401 without it", async () => {
		const contract = setup();
		const { key } = await uploadThroughComponent(contract, { filename: "doc.pdf", contentType: "application/pdf" });

		const { token } = (await contract.run("issueViewerToken", {})) as { token: string };

		expect((await contract.send(`/v1/media/${key}?token=${token}`)).status).toBe(200);
		expect((await contract.send(`/v1/media/${key}`)).status).toBe(401);
	});

	it("receives the Worker's transcode webhooks with the bearer it checks against DEVULTUR_SECRET", async () => {
		const contract = setup();
		const { key } = await uploadThroughComponent(contract, { filename: "clip.mp4", contentType: "video/mp4" });

		const job = (await contract.run("processVideo", { key })) as { jobId: string };
		expect(job.jobId).toBeTruthy();
		const launch = contract.container.launches[0];
		expect(launch?.env.CALLBACK_SECRET).toBe(TRANSCODE_WEBHOOK_SECRET);
		const videoId = launch?.env.VIDEO_ID;

		// The runner reports completion to the Worker with TRANSCODE_WEBHOOK_SECRET (what the transcode script sends).
		const callback = await contract.send("/v1/webhooks/transcode", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${TRANSCODE_WEBHOOK_SECRET}` },
			body: JSON.stringify({ event: MediaEventName.TRANSCODE_COMPLETE, videoId, duration: 12 }),
		});
		expect(callback.status).toBe(200);

		// The Worker forwarded a MediaEvent to the component's webhook with WORKER_AUTH_SECRET, and it was accepted.
		expect(contract.webhookDeliveries).toHaveLength(1);
		const [delivery] = contract.webhookDeliveries;
		expect(delivery?.url).toBe(`${CONVEX_SITE_URL}/webhook`);
		expect(delivery?.authorization).toBe(`Bearer ${WORKER_AUTH_SECRET}`);
		expect(delivery?.body).toMatchObject({ event: MediaEventName.TRANSCODE_COMPLETE, videoId, duration: 12 });
		expect(delivery?.status).toBe(200);
		expect(contract.runMutation).toHaveBeenCalledWith("public.handleWebhookEvent", delivery?.body);
		// Convex validates arguments strictly: every field of the forwarded event must be one the mutation declares.
		const declaredFields = Object.keys(component.handleWebhookEvent?.args ?? {});
		expect(declaredFields).toEqual(expect.arrayContaining(Object.keys(delivery?.body ?? {})));

		// The same request with another secret configured on the component is rejected.
		componentEnv.DEVULTUR_SECRET = "another-secret";
		const replay = new Request(`${CONVEX_SITE_URL}/webhook`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: delivery?.authorization ?? "" },
			body: JSON.stringify(delivery?.body),
		});
		expect((await contract.deliverToComponent(replay)).status).toBe(401);
	});

	it("moves a video transcoded without captions straight to ready", async () => {
		const contract = setup();
		const { key } = await uploadThroughComponent(contract, { filename: "clip.mp4", contentType: "video/mp4" });
		const mediaKey = key.split("/")[2] ?? "";

		await contract.run("processVideo", { key });
		expect(await contract.mediaRecord(mediaKey)).toMatchObject({ transcodeStatus: "queued", captionsPending: false });

		await completeTranscode(contract);
		expect(await contract.mediaRecord(mediaKey)).toMatchObject({ transcodeStatus: "ready", duration: 12 });
	});

	it("keeps a video with requested captions in captioning until they arrive", async () => {
		const contract = setup();
		const { key } = await uploadThroughComponent(contract, { filename: "clip.mp4", contentType: "video/mp4" });
		const mediaKey = key.split("/")[2] ?? "";

		// The transcode completes while the transcription is still running.
		const transcriptionDone = Promise.withResolvers<void>();
		contract.transcription.isAvailable = true;
		contract.transcription.pending = transcriptionDone.promise;
		const processing = contract.run("processVideo", { key, locales: ["en"] });
		await contract.transcription.requested.promise;
		await completeTranscode(contract);
		expect(await contract.mediaRecord(mediaKey)).toMatchObject({
			transcodeStatus: "captioning",
			captionsPending: true,
		});

		// The Worker forwards `captions.complete` once the transcription returns.
		transcriptionDone.resolve();
		await processing;
		expect(await contract.mediaRecord(mediaKey)).toMatchObject({
			transcodeStatus: "ready",
			captionsPending: false,
			captionLocales: ["en"],
		});
	});

	it("reaches ready when the captions arrive before the transcode completes", async () => {
		const contract = setup();
		contract.transcription.isAvailable = true;
		const { key } = await uploadThroughComponent(contract, { filename: "clip.mp4", contentType: "video/mp4" });
		const mediaKey = key.split("/")[2] ?? "";

		// The Worker generates the captions during the request and forwards `captions.complete` right away.
		await contract.run("processVideo", { key, locales: ["en"] });
		expect(await contract.mediaRecord(mediaKey)).toMatchObject({ captionsPending: false, captionLocales: ["en"] });

		await completeTranscode(contract);
		expect(await contract.mediaRecord(mediaKey)).toMatchObject({ transcodeStatus: "ready" });
	});

	it("stops waiting for captions whose request failed", async () => {
		const contract = setup();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { key } = await uploadThroughComponent(contract, { filename: "clip.mp4", contentType: "video/mp4" });
		const mediaKey = key.split("/")[2] ?? "";

		await contract.run("processVideo", { key, locales: ["en"] });

		expect(contract.runMutation).toHaveBeenCalledWith("public.skipCaptions", { key: mediaKey });
		expect(await contract.mediaRecord(mediaKey)).toMatchObject({ captionsPending: false });
	});

	it("deletes a file and a video so the next read is 404", async () => {
		const contract = setup();
		const file = await uploadThroughComponent(contract, { filename: "doc.pdf", contentType: "application/pdf" });
		const video = await uploadThroughComponent(contract, { filename: "clip.mp4", contentType: "video/mp4" });
		const videoId = video.key.split("/")[2];

		await contract.run("deleteMediaAction", { key: file.key });
		const deleted = (await contract.run("deleteVideo", { videoId, visibility: "private" })) as {
			deletedCount: number;
		};

		expect(deleted.deletedCount).toBeGreaterThan(0);
		const owner = { headers: { Authorization: `Bearer ${WORKER_AUTH_SECRET}` } };
		expect((await contract.send(`/v1/media/${file.key}`, owner)).status).toBe(404);
		expect((await contract.send(`/v1/media/${video.key}`, owner)).status).toBe(404);
	});

	it("only calls routes the Worker serves", async () => {
		const contract = setup();
		const file = await uploadThroughComponent(contract, { filename: "doc.pdf", contentType: "application/pdf" });
		const video = await uploadThroughComponent(contract, { filename: "clip.mp4", contentType: "video/mp4" });
		await contract.run("issueViewerToken", { sessionSecret: "session-secret" });
		// Captions call a transcription provider, which this test's network refuses: the component swallows that
		// failure (the route answers 500), and the route still has to exist.
		vi.spyOn(console, "error").mockImplementation(() => {});
		await contract.run("processVideo", { key: video.key, locales: ["en"] });
		await contract.run("deleteMediaAction", { key: file.key });
		await contract.run("deleteVideo", { videoId: video.key.split("/")[2] });

		const routeOf = ({ method, path }: WorkerCall) => `${method} /${path.split("/").slice(1, 3).join("/")}`;
		expect(new Set(contract.workerCalls.map(routeOf))).toEqual(
			new Set([
				"POST /v1/upload",
				"PUT /v1/upload",
				"POST /v1/token",
				"POST /v1/transcode",
				"POST /v1/captions",
				"DELETE /v1/media",
			]),
		);
		for (const call of contract.workerCalls) {
			expect(call.status, `${call.method} ${call.path}`).not.toBe(404);
		}
	});
});
