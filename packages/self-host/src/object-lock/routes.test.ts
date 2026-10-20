import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryBucket } from "../exports-test-harness";
import { KvPrefix } from "../helpers";
import { createWorker } from "../index";
import { WORKER_SECRETS, withWorkerAuth } from "../plugins/worker-secret-auth-test-env";

// Every route of `createWorker()` that can change stored bytes must go through the lock guard. This test lists each
// PUT/POST/DELETE route and says why it's safe: a new route fails here until someone classifies it.
const RAW_KEY = "private/video/vid1/raw/clip.mp4";
const CAPTION_KEY = "private/video/vid1/captions/en.vtt";

type Fixture = ReturnType<typeof lockedFixture>;

type Classification =
	| { guarded: (fixture: Fixture) => Promise<void> }
	| { nonDestructive: string }
	/** Overwrite paths: the guard lands in the next change, which turns these into `guarded`. */
	| { pending: string };

function lockedFixture() {
	const mediaBucket = memoryBucket();
	const keysBucket = memoryBucket();
	const kv = new Map<string, string>();
	const lock = JSON.stringify({ retention: { mode: "compliance", until: "2999-01-01T00:00:00Z" }, hold: false });
	mediaBucket.objects.set(RAW_KEY, { bytes: new Uint8Array(4), httpMetadata: {}, customMetadata: { lock } });
	mediaBucket.objects.set(CAPTION_KEY, { bytes: new Uint8Array(4), httpMetadata: {}, customMetadata: {} });
	keysBucket.objects.set(`${RAW_KEY}/key-1`, { bytes: new Uint8Array(4), httpMetadata: {}, customMetadata: {} });
	const env = {
		...WORKER_SECRETS,
		DELIVERY_SIGN_SECRET: "delivery",
		MEDIA_BUCKET: mediaBucket,
		KEYS_BUCKET: keysBucket,
		MEDIA_KV: {
			get: async (key: string, type?: string) => {
				const value = kv.get(key) ?? null;
				return type === "json" && value ? JSON.parse(value) : value;
			},
			put: async (key: string, value: string) => void kv.set(key, value),
			delete: async (key: string) => void kv.delete(key),
		},
	};
	const app = createWorker();
	const send = (path: string, init?: RequestInit) =>
		app.request(`https://media.example${path}`, withWorkerAuth(init), env as never, { waitUntil() {} } as never);
	const isIntact = () => mediaBucket.objects.has(RAW_KEY) && keysBucket.objects.has(`${RAW_KEY}/key-1`);
	return { send, kv, mediaBucket, isIntact };
}

async function expectRetentionActive(response: Response): Promise<void> {
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({
		error: `${RAW_KEY} is retained and can't be deleted`,
		code: "retention_active",
		key: RAW_KEY,
		mode: "compliance",
		until: "2999-01-01T00:00:00.000Z",
		hold: false,
	});
}

const ROUTES: Record<string, Classification> = {
	"POST /v1/metrics/playback": { nonDestructive: "answers 204 and stores nothing" },
	"POST /v1/webhooks/transcode": {
		guarded: async ({ send, kv, isIntact }) => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			kv.set(`${KvPrefix.TRANSCODE_RAW}:vid1`, JSON.stringify({ storageKey: RAW_KEY, deleteOnComplete: true }));
			const response = await send("/v1/webhooks/transcode", {
				method: "POST",
				body: JSON.stringify({ event: "transcode.complete", videoId: "vid1", duration: 1 }),
			});
			// Not a 409: the transcode did finish, the raw just isn't deleted (decision 6).
			expect(response.status).toBe(200);
			expect(isIntact()).toBe(true);
		},
	},
	"POST /v1/upload": { nonDestructive: "creates a pending upload under a fresh key; bytes land in the PUT" },
	"POST /v1/upload/:key{.+}": { pending: "multipart complete can replace an existing key" },
	"DELETE /v1/upload/:key{.+}": { nonDestructive: "aborts an in-progress multipart; a completed object is untouched" },
	"PUT /v1/upload/:key{.+}": { pending: "a single PUT can overwrite an existing key" },
	"DELETE /v1/media/videos/:videoId": {
		guarded: async ({ send, mediaBucket, isIntact }) => {
			await expectRetentionActive(await send("/v1/media/videos/vid1", { method: "DELETE" }));
			expect(isIntact()).toBe(true);
			expect(mediaBucket.objects.has(CAPTION_KEY)).toBe(true);
		},
	},
	"DELETE /v1/media/:key{.+}": {
		guarded: async ({ send, mediaBucket, isIntact }) => {
			await expectRetentionActive(await send(`/v1/media/${RAW_KEY}`, { method: "DELETE" }));
			// A derived file inherits the raw's retention (`derivatives: "inherit"` by default).
			await expectRetentionActive(await send(`/v1/media/${CAPTION_KEY}`, { method: "DELETE" }));
			expect(isIntact()).toBe(true);
			expect(mediaBucket.objects.has(CAPTION_KEY)).toBe(true);
		},
	},
	"POST /v1/transcode": { pending: "re-transcoding a retained video overwrites its outputs" },
	"POST /v1/captions": { pending: "writes caption files, possibly over an existing locale" },
	"POST /v1/token": { nonDestructive: "signs a viewer token" },
	"POST /v1/token/upload": { nonDestructive: "signs an upload token" },
	"POST /v1/token/download": { nonDestructive: "issues a download link" },
};

const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

function writeRoutes(): string[] {
	const routes = createWorker().routes.filter((route) => WRITE_METHODS.has(route.method));
	return [...new Set(routes.map((route) => `${route.method} ${route.path}`))];
}

afterEach(() => vi.restoreAllMocks());

describe("object lock: every write route is classified", () => {
	it("classifies exactly the Worker's PUT/POST/DELETE routes", () => {
		expect(writeRoutes().sort()).toEqual(Object.keys(ROUTES).sort());
	});

	for (const [route, classification] of Object.entries(ROUTES)) {
		if ("guarded" in classification) {
			it(`${route} rejects a locked object`, () => classification.guarded(lockedFixture()));
		} else if ("pending" in classification) {
			it.todo(`${route}: ${classification.pending}`);
		} else {
			it(`${route} is non-destructive: ${classification.nonDestructive}`, () => {
				expect(classification.nonDestructive).not.toBe("");
			});
		}
	}
});

describe("reserved lock prefixes", () => {
	it.each([
		["GET", "/v1/media/__lock-audit/2030/event.json"],
		["DELETE", "/v1/media/__lock/private/file/a/doc.pdf"],
		["PUT", "/v1/upload/__lock-audit/forged.json"],
		["DELETE", "/v1/media/%5F%5Flock/x"],
	])("%s %s answers 400 reserved_key", async (method, path) => {
		const { send } = lockedFixture();
		const response = await send(path, { method, body: method === "PUT" ? "x" : undefined });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "reserved_key" });
	});
});
