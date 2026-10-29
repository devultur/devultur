import { createWebhookEvent, type MediaChangedData, type MediaDeletedData } from "@devultur/core";
import { describe, expect, it, vi } from "vitest";
import { lifecycleEventArgs } from "../src/component/lifecycleValidators";
import { memoryDb } from "./memory-db";

// `applyLifecycleEvent`, its pruning and `missingKeys` for real, against an in-memory database.
vi.mock("../src/component/_generated/api", () => ({
	internal: { lifecycle: { pruneProcessedEvents: "lifecycle.pruneProcessedEvents" } },
}));
vi.mock("../src/component/_generated/server", () => {
	const definition = (fn: unknown) => fn;
	return { env: {}, mutation: definition, query: definition, internalMutation: definition };
});

type Handler = (ctx: unknown, args: unknown) => Promise<unknown>;
const lifecycle = (await import("../src/component/lifecycle")) as unknown as Record<string, { handler: Handler }> & {
	PROCESSED_EVENT_TTL_MS: number;
	PRUNE_BATCH: number;
	MAX_PRUNE_RUNS: number;
};

const VIDEO = {
	key: "vid1",
	type: "video",
	filename: "clip.mp4",
	contentType: "video/mp4",
	sizeBytes: 10,
	visibility: "private",
	objectKey: "private/video/vid1/raw/clip.mp4",
	createdAt: 0,
} as const;

const deleted = (at: string, data: Partial<MediaDeletedData> = {}) =>
	createWebhookEvent(
		"media.deleted",
		{ key: "private/video/vid1", mediaId: "vid1", kind: "video", visibility: "private", reason: "api", ...data },
		new Date(at),
	);

const changed = (at: string, data: Partial<MediaChangedData> = {}) =>
	createWebhookEvent(
		"media.changed",
		{ key: VIDEO.objectKey, mediaId: "vid1", changes: ["hold"], lock: { hold: true }, etag: "e1", ...data },
		new Date(at),
	);

async function withVideo() {
	const db = memoryDb();
	await db.insert("media", VIDEO);
	await db.insert("captions", { mediaKey: "vid1", locale: "en", vttUrl: "en.vtt", createdAt: 0 });
	const apply = (event: Parameters<typeof lifecycleEventArgs>[0]) =>
		lifecycle.applyLifecycleEvent.handler({ db }, { event: lifecycleEventArgs(event) }) as Promise<{
			isDuplicate: boolean;
			isApplied: boolean;
		}>;
	const record = () =>
		db
			.query("media")
			.withIndex("by_key", (q) => q.eq("key", "vid1"))
			.first();
	return { db, apply, record };
}

describe("applyLifecycleEvent", () => {
	it("deletes the record and its captions on media.deleted", async () => {
		const { db, apply, record } = await withVideo();

		expect(await apply(deleted("2030-01-01T00:00:00Z"))).toEqual({ isDuplicate: false, isApplied: true });

		expect(await record()).toBeNull();
		expect(db.tables.get("captions")).toEqual([]);
	});

	it("patches the lock and the etag on media.changed", async () => {
		const { apply, record } = await withVideo();

		await apply(changed("2030-01-01T00:00:00Z"));

		expect(await record()).toMatchObject({
			lock: { hold: true },
			etag: "e1",
			lifecycleEventAt: "2030-01-01T00:00:00.000Z",
		});
	});

	it("marks a deleted original without touching the lock", async () => {
		const { apply, record } = await withVideo();

		await apply(changed("2030-01-01T00:00:00Z", { changes: ["original-deleted"], lock: undefined }));

		expect(await record()).toMatchObject({ originalDeleted: true });
		expect(await record()).not.toHaveProperty("lock");
	});

	it("applies a duplicate id once", async () => {
		const { apply, record } = await withVideo();
		const hold = changed("2030-01-01T00:00:01Z");
		const release = changed("2030-01-01T00:00:02Z", { lock: { hold: false } });

		await apply(hold);
		await apply(release);
		const redelivered = await apply(hold);

		expect(redelivered).toEqual({ isDuplicate: true, isApplied: false });
		expect(await record()).toMatchObject({ lock: { hold: false } });
	});

	it("ignores an event older than the last one applied", async () => {
		const { apply, record } = await withVideo();

		await apply(changed("2030-01-01T00:00:02Z", { lock: { hold: false } }));
		const older = await apply(changed("2030-01-01T00:00:01Z", { lock: { hold: true } }));

		expect(older).toEqual({ isDuplicate: false, isApplied: false });
		expect(await record()).toMatchObject({ lock: { hold: false }, lifecycleEventAt: "2030-01-01T00:00:02.000Z" });
	});

	it("keeps the record when a delete older than the last change arrives after it", async () => {
		const { apply, record } = await withVideo();

		await apply(changed("2030-01-01T00:00:02Z", { changes: ["replaced"], lock: undefined, etag: "e2" }));
		await apply(deleted("2030-01-01T00:00:01Z"));

		expect(await record()).toMatchObject({ etag: "e2" });
	});

	it("leaves a deleted record deleted when an older change arrives after the delete", async () => {
		const { apply, record } = await withVideo();

		await apply(deleted("2030-01-01T00:00:02Z"));
		const late = await apply(changed("2030-01-01T00:00:01Z"));

		expect(late.isApplied).toBe(false);
		expect(await record()).toBeNull();
	});

	it("ignores fields a newer Worker adds", async () => {
		const { apply, record } = await withVideo();
		const event = changed("2030-01-01T00:00:00Z");

		await apply({ ...event, data: { ...event.data, size: 10 } } as typeof event);

		expect(lifecycleEventArgs({ ...event, data: { ...event.data, size: 10 } } as typeof event).data).not.toHaveProperty(
			"size",
		);
		expect(await record()).toMatchObject({ lock: { hold: true } });
	});

	it("prunes processed ids older than 7 days in its own scheduled run", async () => {
		const { db, apply } = await withVideo();
		const old = Date.now() - lifecycle.PROCESSED_EVENT_TTL_MS - 1;
		await db.insert("processedEvents", {
			eventId: "evt_old",
			status: "handled",
			type: "media.changed",
			mediaId: "vid1",
			occurredAt: new Date(old).toISOString(),
			processedAt: old,
		});
		await apply(changed("2030-01-01T00:00:00Z"));
		expect(db.tables.get("processedEvents")).toHaveLength(2);

		const scheduler = { runAfter: vi.fn(async () => {}) };
		const pruned = await lifecycle.pruneProcessedEvents.handler({ db, scheduler }, {});

		expect(pruned).toBe(1);
		expect(db.tables.get("processedEvents")?.map((row) => row.eventId)).not.toContain("evt_old");
	});

	it("chains another prune right away after a full batch, up to its bound", async () => {
		const db = memoryDb();
		const old = Date.now() - lifecycle.PROCESSED_EVENT_TTL_MS - 1;
		const insertExpired = async (count: number) => {
			for (let index = 0; index < count; index++) {
				await db.insert("processedEvents", {
					eventId: `evt_${index}`,
					status: "handled",
					type: "media.deleted",
					mediaId: "m",
					occurredAt: new Date(old).toISOString(),
					processedAt: old,
				});
			}
		};
		await insertExpired(lifecycle.PRUNE_BATCH + 3);
		const scheduler = { runAfter: vi.fn(async (_delay: number, _ref: string, _args: { run: number }) => {}) };

		expect(await lifecycle.pruneProcessedEvents.handler({ db, scheduler }, {})).toBe(lifecycle.PRUNE_BATCH);
		expect(scheduler.runAfter).toHaveBeenCalledWith(0, "lifecycle.pruneProcessedEvents", { run: 2 });

		const [, , args] = scheduler.runAfter.mock.calls[0];
		expect(await lifecycle.pruneProcessedEvents.handler({ db, scheduler }, args)).toBe(3);
		expect(scheduler.runAfter).toHaveBeenCalledTimes(1);
		expect(db.tables.get("processedEvents")).toEqual([]);

		// The last run of a chain stops even with a full batch: the next hourly run goes on.
		await insertExpired(lifecycle.PRUNE_BATCH + 1);
		await lifecycle.pruneProcessedEvents.handler({ db, scheduler }, { run: lifecycle.MAX_PRUNE_RUNS });
		expect(scheduler.runAfter).toHaveBeenCalledTimes(1);
		expect(db.tables.get("processedEvents")).toHaveLength(1);
	});

	it("keeps an id awaiting the app's handler open: a redelivery isn't a duplicate until it's handled", async () => {
		const { db, record } = await withVideo();
		const event = lifecycleEventArgs(changed("2030-01-01T00:00:00Z"));
		const apply = (awaitsHandler?: boolean) =>
			lifecycle.applyLifecycleEvent.handler({ db }, { event, awaitsHandler }) as Promise<{ isDuplicate: boolean }>;

		expect((await apply(true)).isDuplicate).toBe(false);
		// The action died before the handler finished: the Worker redelivers.
		expect((await apply(true)).isDuplicate).toBe(false);
		await lifecycle.markLifecycleEventHandled.handler({ db }, { eventId: event.id });

		expect((await apply(true)).isDuplicate).toBe(true);
		expect(await record()).toMatchObject({ lock: { hold: true } });
	});

	it("ignores an event from before the record was created (an earlier upload at the same key)", async () => {
		const db = memoryDb();
		await db.insert("media", { ...VIDEO, createdAt: Date.parse("2030-01-01T00:00:05Z") });

		const stale = await lifecycle.applyLifecycleEvent.handler(
			{ db },
			{ event: lifecycleEventArgs(deleted("2030-01-01T00:00:01Z")) },
		);

		expect(stale).toEqual({ isDuplicate: false, isApplied: false });
		expect(db.tables.get("media")).toHaveLength(1);
	});

	it("settles two events at the same time by id, in either arrival order", async () => {
		const at = "2030-01-01T00:00:01Z";
		const hold = { ...changed(at), id: "evt_1" };
		const release = { ...changed(at, { lock: { hold: false } }), id: "evt_2" };

		for (const order of [
			[hold, release],
			[release, hold],
		]) {
			const { apply, record } = await withVideo();
			for (const event of order) await apply(event);
			expect(await record()).toMatchObject({ lock: { hold: false }, lifecycleEventId: "evt_2" });
		}
	});
});

describe("missingKeys", () => {
	it("returns the keys with no record, in order, each once", async () => {
		const { db } = await withVideo();

		const missing = await lifecycle.missingKeys.handler({ db }, { keys: ["gone", "vid1", "lost", "gone"] });

		expect(missing).toEqual(["gone", "lost"]);
	});

	it("refuses more than 500 keys", async () => {
		const { db } = await withVideo();
		const keys = Array.from({ length: 501 }, (_, index) => `k${index}`);

		await expect(lifecycle.missingKeys.handler({ db }, { keys })).rejects.toThrow("at most 500");
	});
});
