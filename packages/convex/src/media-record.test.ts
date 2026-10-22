import { describe, expect, it } from "vitest";
import { mediaFromRecord } from "./media-record";
import type { MediaRecord } from "./types";

const record: MediaRecord = {
	key: "abc123",
	type: "image",
	filename: "Cover photo.png",
	contentType: "image/png",
	sizeBytes: 2048,
	visibility: "public",
	objectKey: "public/image/abc123/Cover_photo.png",
	width: 640,
	height: 480,
	createdAt: 0,
};

describe("mediaFromRecord", () => {
	it("turns a confirmed upload's record into its reference", () => {
		expect(mediaFromRecord(record)).toEqual({
			id: "abc123",
			kind: "image",
			visibility: "public",
			filename: "Cover photo.png",
			key: "public/image/abc123/Cover_photo.png",
			sizeBytes: 2048,
			width: 640,
			height: 480,
		});
	});

	it("carries the record's metadata, and leaves out what it doesn't have", () => {
		const described: MediaRecord = {
			...record,
			title: "Cover",
			alt: "A mountain at dawn",
			tags: ["landscape"],
			searchText: "cover cover photo.png",
		};
		expect(mediaFromRecord(described)).toMatchObject({
			title: "Cover",
			alt: "A mountain at dawn",
			tags: ["landscape"],
		});
		expect(mediaFromRecord(described)).not.toHaveProperty("searchText");
		expect(mediaFromRecord(record)).not.toHaveProperty("title");

		const pdf: MediaRecord = { ...record, type: "file", contentType: "application/pdf", pageCount: 12 };
		expect(mediaFromRecord(pdf)).toMatchObject({ pageCount: 12 });
		const video: MediaRecord = { ...record, type: "video", duration: 42.5 };
		expect(mediaFromRecord(video)).toMatchObject({ duration: 42.5 });
	});

	it("is null for a record without a visibility", () => {
		const { visibility: _visibility, ...legacy } = record;
		expect(mediaFromRecord(legacy)).toBeNull();
	});
});
