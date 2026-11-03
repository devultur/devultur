import type { ObjectLock } from "@devultur/core";
import { describe, expect, it } from "vitest";
import { type DeletedObject, deletePrefixRespectingLocks, mediaDeletedEvents } from "../index";
import { compliance, lockBuckets, ROOT } from "../object-lock/prefix-test-support";

const originalOnly: ObjectLock = {
	retention: { mode: "compliance", until: "2999-01-01T00:00:00Z", derivatives: "original-only" },
	hold: false,
};

async function deleteReporting(buckets: ReturnType<typeof lockBuckets>, maxSubrequests?: number) {
	const calls: DeletedObject[][] = [];
	const result = await deletePrefixRespectingLocks({
		mediaBucket: buckets.mediaBucket,
		keysBucket: buckets.keysBucket,
		prefix: ROOT,
		...(maxSubrequests ? { maxSubrequests } : {}),
		onDeleted: (objects) => void calls.push(objects),
	});
	return { result, calls };
}

describe("media.deleted events of a prefix delete", () => {
	it("is one event per media whose original went, none for what was kept", async () => {
		const buckets = lockBuckets();
		// A free video: one event for the whole folder.
		await buckets.putObject("public/video/v2/raw/clip.mp4");
		await buckets.putObject("public/video/v2/hls/seg-0.ts");
		// Its outputs go, its retained original stays: still a video, no event.
		await buckets.putObject("private/video/v1/raw/clip.mp4", { lock: originalOnly });
		await buckets.putObject("private/video/v1/hls/seg-0.ts");
		// One original of two went, the other is retained: an event that counts what stayed.
		await buckets.putObject("private/video/v3/raw/a.mp4");
		await buckets.putObject("private/video/v3/raw/b.mp4", { lock: originalOnly });
		// An image and its variant: one event.
		await buckets.putObject("public/image/i1/photo.jpg");
		await buckets.putObject("public/image/i1/photo.jpg/__variants/w320.webp");
		// A retained file: no event.
		await buckets.putObject("private/file/f1/a.pdf", { lock: compliance });

		const { result, calls } = await deleteReporting(buckets, 500);
		const events = mediaDeletedEvents(calls.flat(), { reason: "purge", retained: result.retained });

		expect(calls).toHaveLength(1);
		expect(calls[0].map((object) => object.key)).not.toContain("private/file/f1/a.pdf");
		expect(calls[0][0]).toMatchObject({
			root: ROOT,
			storageKey: `${ROOT}${calls[0][0].key}`,
			etag: expect.any(String),
		});
		expect(events.map((event) => event.data)).toEqual([
			{
				key: "private/video/v3",
				mediaId: "v3",
				kind: "video",
				visibility: "private",
				reason: "purge",
				retainedCount: 1,
			},
			{ key: "public/image/i1/photo.jpg", mediaId: "i1", kind: "image", visibility: "public", reason: "purge" },
			{ key: "public/video/v2", mediaId: "v2", kind: "video", visibility: "public", reason: "purge" },
		]);
		expect(new Set(events.map((event) => event.id)).size).toBe(3);
	});

	it("reports each call's deletes when the budget splits the prefix", async () => {
		const buckets = lockBuckets();
		for (const id of ["f1", "f2", "f3", "f4"]) await buckets.putObject(`private/file/${id}/a.pdf`);

		const deleted: DeletedObject[] = [];
		let cursor: string | undefined;
		let calls = 0;
		do {
			const result = await deletePrefixRespectingLocks({
				mediaBucket: buckets.mediaBucket,
				keysBucket: buckets.keysBucket,
				prefix: ROOT,
				maxSubrequests: 12,
				...(cursor ? { cursor } : {}),
				onDeleted: (objects) => void deleted.push(...objects),
			});
			cursor = result.cursor;
			calls += 1;
		} while (cursor);

		expect(calls).toBeGreaterThan(1);
		expect(mediaDeletedEvents(deleted).map((event) => event.data.mediaId)).toEqual(["f1", "f2", "f3", "f4"]);
	});

	it("doesn't call onDeleted when nothing was deleted, and a failing one doesn't fail the delete", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("private/file/f1/a.pdf", { lock: compliance });
		const empty = await deleteReporting(buckets);

		await buckets.putObject("private/file/f2/a.pdf");
		const result = await deletePrefixRespectingLocks({
			mediaBucket: buckets.mediaBucket,
			prefix: ROOT,
			onDeleted: () => {
				throw new Error("webhook down");
			},
		});

		expect(empty.calls).toEqual([]);
		expect(result.deletedCount).toBe(1);
	});
});
