import { MediaEventName, sha256Hex, signWebhook } from "@devultur/core";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryBucket, SIGN_SECRET } from "../../self-host/src/exports-test-harness";
import { createWorker } from "../../self-host/src/index";
import type { TranscodeContainerNamespace } from "../../self-host/src/transcode/cloudflare";
import { devulturErrorOf, isDevulturError } from "../src/errors";
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
	componentEnv: {} as { DEVULTUR_SECRET?: string; DEVULTUR_API_URL?: string; DEVULTUR_WEBHOOK_SECRET?: string },
}));
// The Worker's media webhook secret (MEDIA_WEBHOOK_SECRET), set on the component as DEVULTUR_WEBHOOK_SECRET.
const MEDIA_WEBHOOK_SECRET = "whsec_bWVkaWEtd2ViaG9vay1jb250cmFjdC1zZWNyZXQ=";

vi.mock("../src/component/_generated/server", () => {
	const definition = (fn: FunctionDefinition) => fn;
	return {
		env: componentEnv,
		action: definition,
		mutation: definition,
		query: definition,
		internalMutation: definition,
		internalAction: definition,
		httpAction: (handler: unknown) => handler,
	};
});
vi.mock("../src/component/_generated/api", () => {
	// `api.<module>.<name>` is the string "<module>.<name>".
	const modules = new Proxy(
		{},
		{ get: (_target, module) => new Proxy({}, { get: (_inner, name) => `${String(module)}.${String(name)}` }) },
	);
	return { api: modules, internal: modules };
});

// The component's modules (public.ts, lock.ts, uploads.ts, lifecycle.ts), by function name: no name repeats across them.
const component = {
	...(await import("../src/component/public")),
	...(await import("../src/component/lock")),
	...(await import("../src/component/uploads")),
	...(await import("../src/component/lifecycle")),
} as unknown as Record<string, FunctionDefinition>;
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
	signature: string | null;
	body: Record<string, unknown>;
	status: number;
}

/**
 * The self-hosted Worker plus the network between it, the component and the browser: `fetch` to the Worker's URL
 * goes to the in-memory app, `fetch` to the Convex site goes to the component's HTTP router (the Worker forwarding a
 * webhook), and anything else fails.
 */
function setup(options: { mediaWebhooks?: boolean } = {}) {
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
		// The Worker's media lifecycle webhooks, to the component's route.
		...(options.mediaWebhooks
			? { MEDIA_WEBHOOK_URL: `${CONVEX_SITE_URL}/webhook`, MEDIA_WEBHOOK_SECRET: MEDIA_WEBHOOK_SECRET }
			: {}),
	};
	// The transcription provider the captions route calls. Off by default: the network refuses it. When available,
	// it answers once `pending` settles, and resolves `requested` when the Worker calls it.
	const transcription = {
		isAvailable: false,
		pending: Promise.resolve(),
		requested: Promise.withResolvers<void>(),
	};
	const app = createWorker();
	// Work the Worker runs after the response (its media webhooks): `settle()` waits for it.
	const pending: Promise<unknown>[] = [];
	const executionCtx = {
		waitUntil: (task: Promise<unknown>) => void pending.push(task),
		passThroughOnException() {},
	} as never;
	const settle = async () => {
		while (pending.length > 0) await Promise.all(pending.splice(0));
	};
	const workerCalls: WorkerCall[] = [];
	const webhookDeliveries: WebhookDelivery[] = [];
	const db = memoryDb();
	// `api.<module>.x` / `internal.<module>.x` are the strings "<module>.x" here (see the `_generated/api` mock).
	const runFunction = async (reference: string, args: unknown) => {
		const fn = component[reference.replace(/^\w+\./, "")];
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
				signature: request.headers.get("webhook-signature"),
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

	const scheduled: Array<{ delayMs: number; reference: string; args: unknown }> = [];
	const ctx = {
		runQuery: vi.fn(runFunction),
		runMutation,
		scheduler: {
			runAfter: vi.fn(async (delayMs: number, reference: string, args: unknown) => {
				scheduled.push({ delayMs, reference, args });
			}),
		},
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
	/** A component query, run against the database (actions go through `run`). */
	const query = (name: string, args: unknown) => runFunction(`public.${name}`, args);
	/** The component's media library, as `listMedia` returns it. */
	const listMedia = (args: { type?: string } = {}) =>
		runFunction("public.listMedia", args) as Promise<Record<string, unknown>[]>;

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
		listMedia,
		query,
		scheduled,
		db,
		transcription,
		settle,
	};
}

type Contract = ReturnType<typeof setup>;

// The Worker checks an upload's first bytes against its type: each fake file starts with its type's real signature.
const SIGNATURES: Record<string, number[]> = {
	"application/pdf": [...new TextEncoder().encode("%PDF-1.7\n")],
	"image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
	// A 320×240 logical screen: the Worker reads the size from it.
	"image/gif": [...new TextEncoder().encode("GIF89a"), 0x40, 0x01, 0xf0, 0x00],
	"video/mp4": [0, 0, 0, 16, ...new TextEncoder().encode("ftypisom"), 0, 0, 2, 0],
};

function fakeFileBytes(filename: string, contentType: string): Uint8Array<ArrayBuffer> {
	const body = new TextEncoder().encode(`bytes of ${filename}`);
	const signature = SIGNATURES[contentType] ?? [];
	const bytes = new Uint8Array(signature.length + body.length);
	bytes.set(signature);
	bytes.set(body, signature.length);
	return bytes;
}

async function uploadThroughComponent(
	contract: Contract,
	file: { filename: string; contentType: string; hold?: boolean },
) {
	const created = (await contract.run("createUploadUrl", { ...file, visibility: "private" })) as {
		url: string;
		key: string;
	};
	const bytes = fakeFileBytes(file.filename, file.contentType);
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
	componentEnv.DEVULTUR_WEBHOOK_SECRET = MEDIA_WEBHOOK_SECRET;
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

	it("keeps a file uploaded with a hold until the component releases it", async () => {
		const contract = setup();
		const { key, put } = await uploadThroughComponent(contract, {
			filename: "deed.pdf",
			contentType: "application/pdf",
			hold: true,
		});
		expect(put.status).toBe(200);
		expect(await contract.run("getLock", { key })).toMatchObject({ key, hold: true, source: "upload" });

		// A ConvexError keeps its data across the component boundary: the app reads the Worker's code and details.
		const refusal = await contract.run("deleteMediaAction", { key }).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(ConvexError);
		expect(isDevulturError(refusal)).toBe(true);
		expect(devulturErrorOf(refusal)).toMatchObject({
			code: "retention_active",
			status: 409,
			details: { key, hold: true },
		});
		expect((refusal as ConvexError<{ code: string }>).data.code).toBe("retention_active");
		expect(contract.mediaBucket.objects.has(key)).toBe(true);

		expect(await contract.run("releaseHold", { keys: [key] })).toMatchObject({ updated: [key], skipped: [] });
		await contract.run("deleteMediaAction", { key });
		expect(contract.mediaBucket.objects.has(key)).toBe(false);
	});

	it("sets and extends a retention through the component", async () => {
		const contract = setup();
		const { key } = await uploadThroughComponent(contract, { filename: "deed.pdf", contentType: "application/pdf" });
		await contract.run("setLock", { key, mode: "compliance", until: "2999-01-01T00:00:00Z" });
		await expect(contract.run("setLock", { key, until: "2998-01-01T00:00:00Z" })).rejects.toMatchObject({
			data: { status: 409, code: "compliance_extend_only" },
		});
		expect(await contract.run("setHold", { keys: [key] })).toMatchObject({ updated: [key] });
		expect(await contract.run("getLock", { key })).toMatchObject({ mode: "compliance", hold: true, source: "sidecar" });
	});

	it("rethrows every Worker refusal as a ConvexError, not only the lock ones", async () => {
		const contract = setup();
		// A delete of a missing file: the Worker answers 404 without a code.
		const missing = await contract.run("deleteMediaAction", { key: "private/file/none/x.pdf" }).catch((error) => error);
		expect(devulturErrorOf(missing)).toEqual({ code: "worker_error", message: "Not found", status: 404 });
		// Anything that isn't a Worker refusal passes through untouched.
		componentEnv.DEVULTUR_API_URL = "https://elsewhere.example";
		const network = await contract
			.run("deleteMediaAction", { key: "private/file/a/b.pdf" })
			.catch((error: unknown) => error);
		expect(isDevulturError(network)).toBe(false);
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

describe("the media library (confirmed uploads in listMedia)", () => {
	it("records an image and a file once their bytes are stored, and filters them by type", async () => {
		const contract = setup();
		const image = await uploadThroughComponent(contract, { filename: "Cover photo.png", contentType: "image/png" });
		const file = await uploadThroughComponent(contract, { filename: "doc.pdf", contentType: "application/pdf" });

		const record = await contract.run("confirmUpload", {
			key: image.key,
			filename: "Cover photo.png",
			width: 640,
			height: 480,
		});
		await contract.run("confirmUpload", { key: file.key, filename: "doc.pdf" });

		expect(record).toMatchObject({
			key: image.key.split("/")[2],
			objectKey: image.key,
			type: "image",
			visibility: "private",
			// The original name: it sanitizes to the one in the key.
			filename: "Cover photo.png",
			contentType: "image/png",
			sizeBytes: image.bytes.byteLength,
			width: 640,
			height: 480,
		});
		expect(await contract.listMedia()).toHaveLength(2);
		expect(await contract.listMedia({ type: "file" })).toEqual([
			expect.objectContaining({ objectKey: file.key, type: "file", filename: "doc.pdf" }),
		]);
	});

	it("records nothing for an upload URL whose PUT never happened", async () => {
		const contract = setup();
		const created = (await contract.run("createUploadUrl", {
			filename: "doc.pdf",
			contentType: "application/pdf",
		})) as { key: string };

		expect(await contract.run("confirmUpload", { key: created.key })).toBeNull();
		expect(await contract.listMedia()).toEqual([]);
	});

	it("records an upload nobody confirmed when the scheduled check finds its bytes", async () => {
		const contract = setup();
		const { key } = await uploadThroughComponent(contract, { filename: "doc.pdf", contentType: "application/pdf" });

		const [check] = contract.scheduled;
		expect(check).toEqual({
			delayMs: 25 * 60 * 60 * 1000,
			reference: "uploads.confirmUploadLater",
			args: { key, filename: "doc.pdf" },
		});
		await contract.run("confirmUploadLater", check?.args);
		expect(await contract.listMedia()).toEqual([expect.objectContaining({ objectKey: key, type: "file" })]);
	});

	it("keeps one record per video, with the upload's fields and the transcode state", async () => {
		const contract = setup();
		const { key, bytes } = await uploadThroughComponent(contract, { filename: "clip.mp4", contentType: "video/mp4" });
		const videoId = key.split("/")[2] ?? "";

		await contract.run("confirmUpload", { key, filename: "clip.mp4" });
		await contract.run("processVideo", { key });
		// Confirming again (the scheduled check) leaves the transcode state alone.
		await contract.run("confirmUploadLater", { key, filename: "clip.mp4" });

		expect(await contract.listMedia({ type: "video" })).toEqual([
			expect.objectContaining({
				key: videoId,
				objectKey: key,
				sizeBytes: bytes.byteLength,
				visibility: "private",
				transcodeStatus: "queued",
			}),
		]);
	});

	it("drops a deleted file from the library, but keeps one whose delete a hold refused", async () => {
		const contract = setup();
		const free = await uploadThroughComponent(contract, { filename: "doc.pdf", contentType: "application/pdf" });
		const held = await uploadThroughComponent(contract, {
			filename: "deed.pdf",
			contentType: "application/pdf",
			hold: true,
		});
		await contract.run("confirmUpload", { key: free.key });
		await contract.run("confirmUpload", { key: held.key });

		await contract.run("deleteMediaAction", { key: free.key });
		await expect(contract.run("deleteMediaAction", { key: held.key })).rejects.toMatchObject({
			data: { code: "retention_active" },
		});

		expect(await contract.listMedia()).toEqual([expect.objectContaining({ objectKey: held.key })]);
	});

	it("pages the library newest first, filtered by type", async () => {
		const contract = setup();
		const names = ["a.pdf", "b.pdf", "c.pdf"];
		for (const filename of names) {
			const { key } = await uploadThroughComponent(contract, { filename, contentType: "application/pdf" });
			await contract.run("confirmUpload", { key, filename });
		}
		const image = await uploadThroughComponent(contract, { filename: "cover.png", contentType: "image/png" });
		await contract.run("confirmUpload", { key: image.key });

		const page = (cursor: string | null) =>
			contract.query("listMediaPage", { type: "file", paginationOpts: { numItems: 2, cursor } }) as Promise<{
				page: Array<{ filename: string }>;
				isDone: boolean;
				continueCursor: string;
			}>;
		const first = await page(null);
		const second = await page(first.continueCursor);

		expect(first.page.map((record) => record.filename)).toEqual(["c.pdf", "b.pdf"]);
		expect(first.isDone).toBe(false);
		expect(second.page.map((record) => record.filename)).toEqual(["a.pdf"]);
		expect(second.isDone).toBe(true);
	});

	it("refuses to record a key that isn't an upload's", async () => {
		const contract = setup();
		await expect(contract.run("confirmUpload", { key: "asset/exports/pkg.zip" })).rejects.toMatchObject({
			data: { code: "invalid_upload_key" },
		});
	});
});

describe("media metadata recorded at upload", () => {
	it("records the size the Worker read from an image's bytes over the client's hint", async () => {
		const contract = setup();
		const image = await uploadThroughComponent(contract, { filename: "anim.gif", contentType: "image/gif" });

		const head = await contract.send(`/v1/media/${image.key}`, {
			method: "HEAD",
			headers: { Authorization: `Bearer ${WORKER_AUTH_SECRET}` },
		});
		expect(head.headers.get("x-devultur-image-width")).toBe("320");
		const record = await contract.run("confirmUpload", { key: image.key, width: 10, height: 10 });

		expect(record).toMatchObject({
			width: 320,
			height: 240,
			sizeBytes: image.bytes.byteLength,
			searchText: "anim.gif",
		});
	});

	it("records a PDF's page count from the client, and ignores it for other files", async () => {
		const contract = setup();
		const pdf = await uploadThroughComponent(contract, { filename: "Report.pdf", contentType: "application/pdf" });
		const clip = await uploadThroughComponent(contract, { filename: "clip.mp4", contentType: "video/mp4" });

		expect(await contract.run("confirmUpload", { key: pdf.key, filename: "Report.pdf", pageCount: 12 })).toMatchObject({
			pageCount: 12,
			searchText: "report.pdf",
		});
		expect(await contract.run("confirmUpload", { key: clip.key, pageCount: 3 })).not.toHaveProperty("pageCount");
	});

	it.each([
		{ pageCount: 0 },
		{ pageCount: 2.5 },
		{ width: -1 },
		{ height: 100_001 },
	])("drops the client hint %o, logs it and records the upload", async (hint) => {
		const contract = setup();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const pdf = await uploadThroughComponent(contract, { filename: "doc.pdf", contentType: "application/pdf" });

		const record = await contract.run("confirmUpload", { key: pdf.key, pageCount: 4, ...hint });

		const field = Object.keys(hint)[0] as string;
		expect(record).toMatchObject({ filename: "doc.pdf" });
		expect(record).not.toHaveProperty(field);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${field}=`));
		expect(await contract.listMedia()).toHaveLength(1);
		warn.mockRestore();
	});

	it("keeps the valid hints next to a dropped one", async () => {
		const contract = setup();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const pdf = await uploadThroughComponent(contract, { filename: "doc.pdf", contentType: "application/pdf" });

		const record = await contract.run("confirmUpload", { key: pdf.key, pageCount: 4, width: 0 });

		expect(record).toMatchObject({ pageCount: 4 });
		expect(record).not.toHaveProperty("width");
		vi.restoreAllMocks();
	});

	it("records a video's duration from the transcode", async () => {
		const contract = setup();
		const { key } = await uploadThroughComponent(contract, { filename: "clip.mp4", contentType: "video/mp4" });
		await contract.run("confirmUpload", { key });
		await contract.run("processVideo", { key });
		await completeTranscode(contract);

		expect(await contract.mediaRecord(key.split("/")[2] ?? "")).toMatchObject({ duration: 12 });
	});
});

describe("@devultur/convex receiving the Worker's media lifecycle webhooks", () => {
	const workerAuth = { Authorization: `Bearer ${WORKER_AUTH_SECRET}` };

	it("removes the record of a file deleted on the Worker, through a signed media.deleted", async () => {
		const contract = setup({ mediaWebhooks: true });
		const file = await uploadThroughComponent(contract, { filename: "doc.pdf", contentType: "application/pdf" });
		await contract.run("confirmUpload", { key: file.key, filename: "doc.pdf" });
		const mediaId = file.key.split("/")[2] ?? "";

		// Deleted by another caller of the Worker (not the component): only the webhook tells the component.
		const response = await contract.send(`/v1/media/${file.key}`, { method: "DELETE", headers: workerAuth });
		await contract.settle();

		expect(response.status).toBe(204);
		const [delivery] = contract.webhookDeliveries;
		expect(delivery).toMatchObject({ url: `${CONVEX_SITE_URL}/webhook`, authorization: null, status: 200 });
		expect(delivery?.signature).toMatch(/^v1,/);
		expect(delivery?.body).toMatchObject({ type: "media.deleted", data: { mediaId, kind: "file", reason: "api" } });
		expect(await contract.mediaRecord(mediaId)).toBeNull();
		expect(await contract.query("missingKeys", { keys: [mediaId] })).toEqual([mediaId]);
	});

	it("patches the record's lock from the Worker's media.changed of a hold", async () => {
		const contract = setup({ mediaWebhooks: true });
		const file = await uploadThroughComponent(contract, { filename: "doc.pdf", contentType: "application/pdf" });
		await contract.run("confirmUpload", { key: file.key, filename: "doc.pdf" });
		const mediaId = file.key.split("/")[2] ?? "";

		await contract.run("setHold", { keys: [file.key] });
		await contract.settle();

		expect(await contract.mediaRecord(mediaId)).toMatchObject({ lock: { hold: true }, etag: expect.any(String) });
	});

	it("applies a redelivered event once", async () => {
		const contract = setup({ mediaWebhooks: true });
		const file = await uploadThroughComponent(contract, { filename: "doc.pdf", contentType: "application/pdf" });
		await contract.run("confirmUpload", { key: file.key, filename: "doc.pdf" });
		await contract.send(`/v1/media/${file.key}`, { method: "DELETE", headers: workerAuth });
		await contract.settle();
		const [delivery] = contract.webhookDeliveries;

		// The same event again, as a retry sends it: signed anew, same id.
		const body = JSON.stringify(delivery?.body);
		const headers = await signWebhook({ id: String(delivery?.body.id), payload: body, secret: MEDIA_WEBHOOK_SECRET });
		const retry = await contract.deliverToComponent(
			new Request(`${CONVEX_SITE_URL}/webhook`, { method: "POST", headers, body }),
		);

		expect(retry.status).toBe(200);
		expect(contract.db.tables.get("processedEvents")).toHaveLength(1);
	});

	it("refuses a lifecycle event signed with another secret", async () => {
		const contract = setup({ mediaWebhooks: true });
		componentEnv.DEVULTUR_WEBHOOK_SECRET = "whsec_b3RoZXI=";
		const file = await uploadThroughComponent(contract, { filename: "doc.pdf", contentType: "application/pdf" });
		await contract.run("confirmUpload", { key: file.key, filename: "doc.pdf" });

		vi.spyOn(console, "error").mockImplementation(() => {});
		await contract.send(`/v1/media/${file.key}`, { method: "DELETE", headers: workerAuth });
		await contract.settle();

		expect(contract.webhookDeliveries.map((delivery) => delivery.status)).toEqual([401]);
		expect(await contract.mediaRecord(file.key.split("/")[2] ?? "")).not.toBeNull();
	});
});
