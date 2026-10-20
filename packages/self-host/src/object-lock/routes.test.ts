import { afterEach, describe, expect, it, vi } from "vitest";
import { KvPrefix } from "../helpers";
import { createWorker } from "../index";
import { CAPTION_KEY, type LockedFixture, lockedFixture, MP4_KEY, RAW_KEY } from "./worker-fixture";

// Every route of `createWorker()` that can change stored bytes (or a lock) must go through the lock guard. This test
// lists each PUT/POST/DELETE route and says why it's safe: a new route fails here until someone classifies it.
type Fixture = LockedFixture;

type Classification = { guarded: (fixture: Fixture) => Promise<void> } | { nonDestructive: string };

async function expectRetentionActive(response: Response, verb = "deleted"): Promise<void> {
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({
		error: `${RAW_KEY} is retained and can't be ${verb}`,
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
	"POST /v1/upload": {
		nonDestructive:
			"creates a pending upload; bytes land in the PUT (an `overwrite` of a locked asset fails fast here)",
	},
	"POST /v1/upload/:key{.+}": {
		guarded: async ({ send, mediaBucket }) => {
			const create = (key: string) =>
				send(`/v1/upload/${key}?multipart=create`, {
					method: "POST",
					body: JSON.stringify({ contentType: "video/mp4", size: 10 }),
				});
			// Create: an existing derived file of the locked video isn't replaced.
			await expectRetentionActive(await create(MP4_KEY), "overwritten");
			// Complete: R2 has no conditional complete, so it re-checks what appeared since the create.
			const newKey = "private/video/vid1/mp4/main-1080p.mp4";
			const created = await create(newKey);
			expect(created.status).toBe(200);
			const { uploadId } = (await created.json()) as { uploadId: string };
			mediaBucket.objects.set(newKey, { bytes: new Uint8Array(1), httpMetadata: {}, customMetadata: {} });
			const complete = await send(`/v1/upload/${newKey}?multipart=complete`, {
				method: "POST",
				body: JSON.stringify({ uploadId, parts: [{ partNumber: 1, etag: "etag-1" }] }),
			});
			await expectRetentionActive(complete, "overwritten");
		},
	},
	"DELETE /v1/upload/:key{.+}": { nonDestructive: "aborts an in-progress multipart; a completed object is untouched" },
	"PUT /v1/upload/:key{.+}": {
		guarded: async ({ send, mediaBucket, isIntact }) => {
			const put = (key: string) =>
				send(`/v1/upload/${key}`, { method: "PUT", body: "new", headers: { "Content-Type": "text/vtt" } });
			await expectRetentionActive(await put(RAW_KEY), "overwritten");
			await expectRetentionActive(await put(CAPTION_KEY), "overwritten");
			expect(isIntact()).toBe(true);
			expect(mediaBucket.objects.get(CAPTION_KEY)?.bytes.byteLength).toBe(4);
			// A new output of the locked video is a create, not an overwrite.
			expect((await put("private/video/vid1/captions/fr.vtt")).status).toBe(200);
		},
	},
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
	"POST /v1/transcode": {
		guarded: async ({ send, keysBucket, mediaBucket }) => {
			// The video already finished a transcode (durable marker): a new one would overwrite retained outputs.
			mediaBucket.objects.set("__lock/private/video/vid1/transcode-completed", {
				bytes: new Uint8Array(1),
				httpMetadata: {},
				customMetadata: {},
			});
			const keyCount = keysBucket.objects.size;
			const res = await send("/v1/transcode", { method: "POST", body: JSON.stringify({ key: RAW_KEY }) });
			// Refused before the runner launches or the HLS key is written: it would overwrite retained outputs.
			await expectRetentionActive(res, "overwritten");
			expect(keysBucket.objects.size).toBe(keyCount);
		},
	},
	"POST /v1/captions": {
		guarded: async ({ send, mediaBucket }) => {
			const fetchSpy = vi.fn(async () => new Response("unavailable", { status: 503 }));
			vi.stubGlobal("fetch", fetchSpy);
			const captions = (locales: string[]) =>
				send("/v1/captions", { method: "POST", body: JSON.stringify({ key: RAW_KEY, locales }) });
			// An existing locale is refused before any transcription is paid for.
			await expectRetentionActive(await captions(["en", "fr"]), "overwritten");
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(mediaBucket.objects.get(CAPTION_KEY)?.bytes.byteLength).toBe(4);
			// A new locale passes the lock check (here the provider then fails, which is not a lock answer).
			vi.spyOn(console, "error").mockImplementation(() => {});
			const fresh = await captions(["fr"]);
			expect(fresh.status).not.toBe(409);
			expect(fetchSpy).toHaveBeenCalled();
		},
	},
	"PUT /v1/lock/:key{.+}": {
		guarded: async ({ send }) => {
			// Compliance only extends: an earlier date is refused like a delete would be.
			const res = await send(`/v1/lock/${RAW_KEY}`, {
				method: "PUT",
				body: JSON.stringify({ until: "2998-01-01T00:00:00Z" }),
			});
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({ code: "compliance_extend_only", key: RAW_KEY });
		},
	},
	"POST /v1/lock/hold": {
		guarded: async ({ send, isIntact }) => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			// A hold only adds protection: holding and releasing a compliance object leaves its retention in force.
			for (const hold of [true, false]) {
				const res = await send("/v1/lock/hold", { method: "POST", body: JSON.stringify({ hold, keys: [RAW_KEY] }) });
				expect(await res.json()).toEqual({ updated: [RAW_KEY], skipped: [] });
			}
			await expectRetentionActive(await send(`/v1/media/${RAW_KEY}`, { method: "DELETE" }));
			expect(isIntact()).toBe(true);
		},
	},
	"POST /v1/token": { nonDestructive: "signs a viewer token" },
	"POST /v1/token/upload": { nonDestructive: "signs an upload token" },
	"POST /v1/token/download": { nonDestructive: "issues a download link" },
};

const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

function writeRoutes(): string[] {
	const routes = createWorker().routes.filter((route) => WRITE_METHODS.has(route.method));
	return [...new Set(routes.map((route) => `${route.method} ${route.path}`))];
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("object lock: every write route is classified", () => {
	it("classifies exactly the Worker's PUT/POST/DELETE routes", () => {
		expect(writeRoutes().sort()).toEqual(Object.keys(ROUTES).sort());
	});

	for (const [route, classification] of Object.entries(ROUTES)) {
		if ("guarded" in classification) {
			it(`${route} rejects a locked object`, () => classification.guarded(lockedFixture()));
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

describe("outputs of an in-progress transcode job", () => {
	const putMp4 = (send: Fixture["send"]) =>
		send(`/v1/upload/${MP4_KEY}`, { method: "PUT", body: "retry", headers: { "Content-Type": "video/mp4" } });
	const startJob = (kv: Fixture["kv"]) =>
		kv.set(`${KvPrefix.TRANSCODE_STATUS}:vid1`, JSON.stringify({ status: "running", jobRef: "job-1", updatedAt: 0 }));

	it("lets the runner rewrite its own output while the job runs (an upload retry)", async () => {
		const { send, kv, mediaBucket } = lockedFixture();
		startJob(kv);

		const retry = await putMp4(send);
		expect(retry.status).toBe(200);
		expect(new TextDecoder().decode(mediaBucket.objects.get(MP4_KEY)?.bytes)).toBe("retry");
		// Only the job's own output prefixes: an existing caption of the locked video stays protected.
		const caption = await send(`/v1/upload/${CAPTION_KEY}`, {
			method: "PUT",
			body: "x",
			headers: { "Content-Type": "text/vtt" },
		});
		expect(caption.status).toBe(409);
	});

	it("protects the outputs once the job completes", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { send, kv } = lockedFixture();
		startJob(kv);
		const complete = await send("/v1/webhooks/transcode", {
			method: "POST",
			body: JSON.stringify({ event: "transcode.complete", videoId: "vid1", duration: 1 }),
		});
		expect(complete.status).toBe(200);

		await expectRetentionActive(await putMp4(send), "overwritten");
	});

	it("protects them with no job record at all", async () => {
		const { send } = lockedFixture();
		await expectRetentionActive(await putMp4(send), "overwritten");
	});
});
