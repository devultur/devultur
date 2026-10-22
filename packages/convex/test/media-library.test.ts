import { describe, expect, it, vi } from "vitest";
import { memoryDb } from "./memory-db";

// `searchMedia`, `backfillSearchText` and the lazy `searchText` fill for real, against an in-memory database.
vi.mock("../src/component/_generated/server", () => {
	const definition = (fn: unknown) => fn;
	return {
		env: {},
		query: definition,
		action: definition,
		mutation: definition,
		internalMutation: definition,
		internalAction: definition,
	};
});
vi.mock("../src/component/_generated/api", () => ({
	api: {},
	internal: { library: { backfillSearchTextBatch: "library.backfillSearchTextBatch" } },
}));
vi.mock("../src/component/workerErrors", () => ({ workerAction: (fn: unknown) => fn }));

type Handler = (ctx: unknown, args: unknown) => Promise<unknown>;
type Module = Record<string, { handler: Handler }>;
const { searchMedia, backfillSearchText, backfillSearchTextBatch } = (await import(
	"../src/component/library"
)) as unknown as Module;
const { updateMedia, handleWebhookEvent } = (await import("../src/component/public")) as unknown as Module;

interface Page {
	page: Array<{ key: string; searchText?: string }>;
	isDone: boolean;
	continueCursor: string;
}

const RECORDS = [
	{ key: "a", type: "image", filename: "beach.png", title: "Summer cover" },
	{ key: "b", type: "image", filename: "mountain.png" },
	{ key: "c", type: "file", filename: "cover-letter.pdf" },
	{ key: "d", type: "video", filename: "intro.mp4", title: "Cover story" },
] as const;

async function libraryWith(records: ReadonlyArray<Record<string, unknown>>, options = { withSearchText: true }) {
	const db = memoryDb();
	for (const [index, record] of records.entries()) {
		const title = typeof record.title === "string" ? `${record.title} ` : "";
		const searchText = `${title}${record.filename}`.toLowerCase();
		await db.insert("media", {
			contentType: "application/octet-stream",
			sizeBytes: 1,
			createdAt: index,
			...(options.withSearchText ? { searchText } : {}),
			...record,
		});
	}
	const scheduled: Array<{ reference: string; args: Record<string, unknown> }> = [];
	const scheduler = {
		runAfter: vi.fn(async (_delay: number, reference: string, args: Record<string, unknown>) => {
			scheduled.push({ reference, args });
		}),
	};
	return { db, scheduler, scheduled, ctx: { db, scheduler } };
}

const keysOf = (page: Page) => page.page.map((record) => record.key);
const firstPage = (numItems = 10) => ({ numItems, cursor: null });

describe("searchMedia", () => {
	it("matches the title and the filename, case-insensitively, with the last word as a prefix", async () => {
		const { ctx } = await libraryWith(RECORDS);
		const found = (await searchMedia.handler(ctx, { search: " COV ", paginationOpts: firstPage() })) as Page;
		expect(keysOf(found).sort()).toEqual(["a", "c", "d"]);
	});

	it("filters by type", async () => {
		const { ctx } = await libraryWith(RECORDS);
		const images = (await searchMedia.handler(ctx, {
			search: "cover",
			type: "image",
			paginationOpts: firstPage(),
		})) as Page;
		expect(keysOf(images)).toEqual(["a"]);
	});

	it("pages through the matches with the cursor", async () => {
		const { ctx } = await libraryWith(RECORDS);
		const first = (await searchMedia.handler(ctx, { search: "cover", paginationOpts: firstPage(2) })) as Page;
		const second = (await searchMedia.handler(ctx, {
			search: "cover",
			paginationOpts: { numItems: 2, cursor: first.continueCursor },
		})) as Page;

		expect(first.page).toHaveLength(2);
		expect(first.isDone).toBe(false);
		expect(second.page).toHaveLength(1);
		expect(second.isDone).toBe(true);
		expect(new Set([...keysOf(first), ...keysOf(second)])).toEqual(new Set(["a", "c", "d"]));
	});

	it("lists newest first, optionally of one type, when the search is blank", async () => {
		const { ctx } = await libraryWith(RECORDS);
		const all = (await searchMedia.handler(ctx, { search: "  ", paginationOpts: firstPage() })) as Page;
		const images = (await searchMedia.handler(ctx, { search: "", type: "image", paginationOpts: firstPage() })) as Page;

		expect(keysOf(all)).toEqual(["d", "c", "b", "a"]);
		expect(keysOf(images)).toEqual(["b", "a"]);
	});

	it("doesn't find records without a searchText (written before 1.4.0)", async () => {
		const { ctx } = await libraryWith(RECORDS, { withSearchText: false });
		const found = (await searchMedia.handler(ctx, { search: "cover", paginationOpts: firstPage() })) as Page;
		expect(found.page).toEqual([]);
	});
});

describe("backfillSearchText", () => {
	const legacyRecords = Array.from({ length: 5 }, (_, index) => ({
		key: `legacy-${index}`,
		type: "image",
		filename: `Photo ${index}.png`,
	}));

	it("fills one batch now and schedules the next from where it stopped", async () => {
		const { ctx, db, scheduled } = await libraryWith(legacyRecords, { withSearchText: false });

		const result = await backfillSearchText.handler(ctx, { batchSize: 2 });

		expect(result).toEqual({ updated: 2, isDone: false });
		expect(db.tables.get("media")?.map((record) => record.searchText)).toEqual([
			"photo 0.png",
			"photo 1.png",
			undefined,
			undefined,
			undefined,
		]);
		expect(scheduled).toEqual([{ reference: "library.backfillSearchTextBatch", args: { cursor: "2", batchSize: 2 } }]);
	});

	it("reschedules itself until every record has a searchText, then stops", async () => {
		const { ctx, db, scheduled } = await libraryWith(legacyRecords, { withSearchText: false });

		await backfillSearchText.handler(ctx, { batchSize: 2 });
		for (let next = scheduled.shift(); next; next = scheduled.shift()) {
			await backfillSearchTextBatch.handler(ctx, next.args);
		}

		expect(db.tables.get("media")?.every((record) => typeof record.searchText === "string")).toBe(true);
		expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(2);
	});

	it("keeps the searchText records already have, and counts only the ones it filled", async () => {
		const { ctx, db } = await libraryWith([
			{ key: "new", type: "file", filename: "a.pdf", searchText: "custom" },
			{ key: "old", type: "file", filename: "B.pdf", title: "Report" },
		]);
		const media = db.tables.get("media") ?? [];
		delete media[1]?.searchText;

		const result = await backfillSearchText.handler(ctx, {});

		expect(result).toEqual({ updated: 1, isDone: true });
		expect(media.map((record) => record.searchText)).toEqual(["custom", "report b.pdf"]);
		expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
	});

	it("bounds the batch size", async () => {
		const { ctx, scheduled } = await libraryWith(legacyRecords, { withSearchText: false });
		await backfillSearchText.handler(ctx, { batchSize: 0 });
		expect(scheduled[0]?.args.batchSize).toBe(1);
	});
});

describe("a write to a record from before 1.4.0", () => {
	it("gives it a searchText (updateMedia)", async () => {
		const { ctx, db } = await libraryWith([{ key: "v1", type: "video", filename: "Intro.mp4" }], {
			withSearchText: false,
		});
		await updateMedia.handler(ctx, { key: "v1", transcodeStatus: "transcoding" });
		expect(db.tables.get("media")?.[0]).toMatchObject({ searchText: "intro.mp4", transcodeStatus: "transcoding" });
	});

	it("gives it a searchText (a transcode webhook)", async () => {
		const { ctx, db } = await libraryWith([{ key: "v1", type: "video", filename: "Intro.mp4", title: "Welcome" }], {
			withSearchText: false,
		});
		await handleWebhookEvent.handler(ctx, { event: "transcode.started", videoId: "v1", totalSegments: 3 });
		expect(db.tables.get("media")?.[0]).toMatchObject({ searchText: "welcome intro.mp4" });
	});
});
