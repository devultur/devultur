import { describe, expect, it, vi } from "vitest";
import { mediaFromRecord } from "../src/media-record";
import type { MediaRecord } from "../src/types";
import { memoryDb } from "./memory-db";

// `updateMediaMeta` and `recordUpload` for real, against an in-memory database.
vi.mock("../src/component/_generated/server", () => {
	const definition = (fn: unknown) => fn;
	return {
		env: {},
		action: definition,
		mutation: definition,
		internalMutation: definition,
		internalAction: definition,
	};
});
vi.mock("../src/component/_generated/api", () => ({ api: {}, internal: {} }));

type Handler = (ctx: unknown, args: unknown) => Promise<unknown>;
const { updateMediaMeta } = (await import("../src/component/metadata")) as unknown as Record<
	string,
	{ handler: Handler }
>;
const { recordUpload } = (await import("../src/component/uploads")) as unknown as Record<string, { handler: Handler }>;
const { default: schema } = await import("../src/component/schema");

// A record as 1.3 wrote it: none of the metadata fields.
const LEGACY_RECORD = {
	key: "abc123",
	type: "image",
	filename: "Cover photo.png",
	contentType: "image/png",
	sizeBytes: 2048,
	visibility: "public",
	objectKey: "public/image/abc123/Cover_photo.png",
	createdAt: 0,
} as const;

async function withRecord(record: Record<string, unknown> = LEGACY_RECORD) {
	const db = memoryDb();
	await db.insert("media", record);
	const edit = (args: Record<string, unknown>) => updateMediaMeta.handler({ db }, { key: "abc123", ...args });
	return { db, edit };
}

describe("updateMediaMeta", () => {
	it("sets the title, alt and tags, trimmed and deduplicated, and keeps searchText in step", async () => {
		const { edit } = await withRecord();

		const updated = await edit({
			title: "  Cover  ",
			alt: "A mountain at dawn",
			tags: [" Landscape", "landscape", "", "dawn"],
		});

		expect(updated).toMatchObject({
			title: "Cover",
			alt: "A mountain at dawn",
			tags: ["Landscape", "dawn"],
			searchText: "cover cover photo.png",
		});
	});

	it("changes only what it's given, and clears a title or alt set to an empty string", async () => {
		const { edit } = await withRecord();
		await edit({ title: "Cover", alt: "A mountain", tags: ["a"] });

		const updated = (await edit({ title: " " })) as Record<string, unknown>;

		expect(updated).not.toHaveProperty("title");
		expect(updated).toMatchObject({ alt: "A mountain", tags: ["a"], searchText: "cover photo.png" });
	});

	it.each([
		["title", { title: "x".repeat(201) }],
		["alt", { alt: "x".repeat(1001) }],
		["tags", { tags: Array.from({ length: 21 }, (_, index) => `tag ${index}`) }],
		["tags", { tags: ["x".repeat(51)] }],
	])("refuses a %s past its limit and changes nothing", async (field, args) => {
		const { db, edit } = await withRecord();

		await expect(edit(args)).rejects.toMatchObject({ data: { code: "invalid_media_metadata", details: { field } } });
		expect(db.tables.get("media")?.[0]).toEqual({ ...LEGACY_RECORD, _id: "media:0" });
	});

	it("accepts the limits themselves", async () => {
		const { edit } = await withRecord();
		const tags = Array.from({ length: 20 }, (_, index) => `${index}`.padEnd(50, "x"));

		await expect(edit({ title: "x".repeat(200), alt: "x".repeat(1000), tags })).resolves.toMatchObject({ tags });
	});

	it("is null when no record has this media id", async () => {
		const { edit } = await withRecord();
		expect(await edit({ key: "missing", title: "x" })).toBeNull();
	});
});

describe("records from before the metadata fields", () => {
	it("stay valid: every new field is optional in the schema", () => {
		const fields = (schema.tables.media.validator as unknown as { fields: Record<string, { isOptional: string }> })
			.fields;
		for (const name of ["title", "alt", "tags", "pageCount", "searchText", "width", "height", "duration"]) {
			expect(fields[name]?.isOptional, name).toBe("optional");
		}
	});

	it("still make a reference, and keep an app-set title when an upload is confirmed again", async () => {
		expect(mediaFromRecord(LEGACY_RECORD as MediaRecord)).toMatchObject({ id: "abc123", sizeBytes: 2048 });

		const { db, edit } = await withRecord();
		await edit({ title: "Cover" });
		const { _id, createdAt, ...upload } = { ...LEGACY_RECORD, _id: "", filename: "Cover photo.png" };
		const recorded = await recordUpload.handler({ db }, upload);

		expect(recorded).toMatchObject({ title: "Cover", searchText: "cover cover photo.png", createdAt });
	});

	it("are searchable by title and filename once written", () => {
		const indexes = (schema.tables.media as unknown as { searchIndexes: Array<Record<string, unknown>> }).searchIndexes;
		expect(indexes).toEqual([{ indexDescriptor: "search_text", searchField: "searchText", filterFields: ["type"] }]);
	});
});
