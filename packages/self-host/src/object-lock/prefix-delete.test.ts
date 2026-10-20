import type { ObjectLock } from "@devultur/core";
import { describe, expect, it } from "vitest";
import { deletePrefixRespectingLocks, type PrefixDeleteResult } from "../index";
import { compliance, expired, governance, lockBuckets, ROOT } from "./prefix-test-support";
import { sidecarKey } from "./sidecar";

const RAW = "private/video/v1/raw/clip.mp4";
const CAPTION = "private/video/v1/captions/en.vtt";
const SEGMENT = "private/video/v1/hls/seg-0.ts";
const HLS_KEY = "private/video/v1/hls/hk1";
const MARKER = "private/video/v1/transcode-completed";

async function videoBuckets(rawLock?: ObjectLock) {
	const buckets = lockBuckets();
	await buckets.putObject(CAPTION);
	await buckets.putObject(SEGMENT);
	await buckets.putObject(RAW, { lock: rawLock });
	await buckets.keys.put(`${ROOT}${HLS_KEY}`, "hls key");
	await buckets.media.put(sidecarKey(ROOT, MARKER), "done");
	return buckets;
}

function deleteAll(buckets: ReturnType<typeof lockBuckets>, prefix = ROOT) {
	return deletePrefixRespectingLocks({ mediaBucket: buckets.mediaBucket, keysBucket: buckets.keysBucket, prefix });
}

describe("deletePrefixRespectingLocks", () => {
	it("deletes free files with their keys and keeps retained ones with theirs", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("private/file/free/a.pdf", { size: 7 });
		await buckets.putObject("private/file/old/a.pdf", { lock: expired, size: 1 });
		await buckets.putObject("private/file/gov/a.pdf", { lock: governance, size: 2 });
		await buckets.putObject("private/file/comp/a.pdf", { lock: compliance, size: 3 });
		await buckets.putObject("private/file/held/a.pdf", { size: 4 });
		await buckets.setSidecar("private/file/held/a.pdf", { hold: true });
		await buckets.putObject("private/file/bad/a.pdf", { size: 5 });
		await buckets.corruptSidecar("private/file/bad/a.pdf");

		const result = await deleteAll(buckets);

		expect(result).toMatchObject({ deletedCount: 2, deletedBytes: 8, retainedCount: 4, retainedBytes: 14 });
		expect(result.cursor).toBeUndefined();
		expect(result.retained.map(({ key, hold, mode, unreadable }) => ({ key, hold, mode, unreadable }))).toEqual([
			{ key: `${ROOT}private/file/bad/a.pdf`, hold: true, mode: undefined, unreadable: true },
			{ key: `${ROOT}private/file/comp/a.pdf`, hold: false, mode: "compliance", unreadable: undefined },
			{ key: `${ROOT}private/file/gov/a.pdf`, hold: false, mode: "governance", unreadable: undefined },
			{ key: `${ROOT}private/file/held/a.pdf`, hold: true, mode: undefined, unreadable: undefined },
		]);
		for (const kept of ["bad", "comp", "gov", "held"]) {
			expect(buckets.hasMedia(`private/file/${kept}/a.pdf`)).toBe(true);
			expect(buckets.hasKey(`private/file/${kept}/a.pdf/k1`)).toBe(true);
		}
		for (const gone of ["free", "old"]) {
			expect(buckets.hasMedia(`private/file/${gone}/a.pdf`)).toBe(false);
			expect(buckets.hasKey(`private/file/${gone}/a.pdf/k1`)).toBe(false);
		}
		// Lock records stay, the retained objects' and the deleted ones' (inert).
		expect(buckets.media.objects.has(sidecarKey(ROOT, "private/file/held/a.pdf"))).toBe(true);
		expect(buckets.media.objects.has(sidecarKey(ROOT, "private/file/bad/a.pdf"))).toBe(true);
	});

	it("keeps a whole video whose raw is retained (derived files inherit)", async () => {
		const buckets = await videoBuckets(compliance);
		const result = await deleteAll(buckets);
		expect(result.deletedCount).toBe(0);
		expect(result.retained.find((kept) => kept.key === `${ROOT}${SEGMENT}`)?.lockedBy).toBe(`${ROOT}${RAW}`);
		for (const key of [RAW, CAPTION, SEGMENT]) expect(buckets.hasMedia(key)).toBe(true);
		expect(buckets.hasKey(HLS_KEY)).toBe(true);
		expect(buckets.media.objects.has(sidecarKey(ROOT, MARKER))).toBe(true);
	});

	it("deletes the derived files of an original-only raw and keeps the raw", async () => {
		const buckets = await videoBuckets({ retention: { ...compliance.retention!, derivatives: "original-only" } });
		const result = await deleteAll(buckets);
		expect(result.retained.map((kept) => kept.key)).toEqual([`${ROOT}${RAW}`]);
		expect(buckets.hasMedia(SEGMENT)).toBe(false);
		expect(buckets.hasMedia(CAPTION)).toBe(false);
		expect(buckets.hasKey(`${RAW}/k1`)).toBe(true);
		// The folder isn't empty: its marker stays.
		expect(buckets.media.objects.has(sidecarKey(ROOT, MARKER))).toBe(true);
	});

	it("deletes a free video like a video delete: folder keys and marker too", async () => {
		const buckets = await videoBuckets();
		const result = await deleteAll(buckets);
		expect(result).toMatchObject({ deletedCount: 3, retainedCount: 0 });
		expect(buckets.hasKey(HLS_KEY)).toBe(false);
		expect([...buckets.keys.objects.keys()]).toEqual([]);
		expect(buckets.media.objects.has(sidecarKey(ROOT, MARKER))).toBe(false);
	});

	it("keeps the variants of a retained image and deletes a free image's with their keys", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("public/image/kept/a.jpg", { lock: compliance });
		await buckets.putObject("public/image/kept/a.jpg/__variants/w200.webp");
		await buckets.putObject("public/image/free/a.jpg");
		await buckets.putObject("public/image/free/a.jpg/__variants/w200.webp");
		await deleteAll(buckets);
		expect(buckets.hasMedia("public/image/kept/a.jpg/__variants/w200.webp")).toBe(true);
		expect(buckets.hasKey("public/image/kept/a.jpg/__variants/w200.webp/k1")).toBe(true);
		expect(buckets.hasMedia("public/image/free/a.jpg/__variants/w200.webp")).toBe(false);
		expect(buckets.hasKey("public/image/free/a.jpg/__variants/w200.webp/k1")).toBe(false);
	});

	it("keeps a nested asset's keys when the asset above it goes", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("private/asset/docs/a");
		await buckets.putObject("private/asset/docs/a/b.pdf", { lock: compliance });
		await deleteAll(buckets);
		expect(buckets.hasMedia("private/asset/docs/a")).toBe(false);
		expect(buckets.hasKey("private/asset/docs/a/k1")).toBe(false);
		expect(buckets.hasKey("private/asset/docs/a/b.pdf/k1")).toBe(true);
	});

	it("walks several storage prefixes at once, each with its own lock records", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("private/file/f1/a.pdf", { root: "apps/a1/" });
		await buckets.setSidecar("private/file/f1/a.pdf", { hold: true }, "apps/a1/");
		await buckets.putObject("private/file/f1/a.pdf", { root: "apps/a2/" });
		await buckets.media.put("apps/a2/__lock-audit/2030-01-01/x.json", "{}");

		const result = await deleteAll(buckets, "apps/");
		expect(result.retained.map((kept) => kept.key)).toEqual(["apps/a1/private/file/f1/a.pdf"]);
		expect(buckets.hasMedia("private/file/f1/a.pdf", "apps/a2/")).toBe(false);
		expect(buckets.media.objects.has("apps/a2/__lock-audit/2030-01-01/x.json")).toBe(true);
	});

	it("resumes from its cursor and never goes past its subrequest bound", async () => {
		const buckets = lockBuckets();
		for (let index = 0; index < 15; index += 1) {
			await buckets.putObject(`private/file/f${String(index).padStart(2, "0")}/a.pdf`, {
				lock: index % 4 === 0 ? compliance : undefined,
			});
		}
		const maxSubrequests = 30;
		const totals = { deletedCount: 0, retainedCount: 0, calls: 0 };
		let cursor: string | undefined;
		do {
			buckets.resetCalls();
			const result: PrefixDeleteResult = await deletePrefixRespectingLocks({
				...buckets.countedBuckets(),
				prefix: ROOT,
				cursor,
				batchSize: 4,
				maxSubrequests,
			});
			expect(buckets.callCount()).toBeLessThanOrEqual(maxSubrequests);
			expect(result.subrequests).toBe(buckets.callCount());
			totals.deletedCount += result.deletedCount;
			totals.retainedCount += result.retainedCount;
			totals.calls += 1;
			cursor = result.cursor;
		} while (cursor);
		expect(totals).toMatchObject({ deletedCount: 11, retainedCount: 4 });
		expect(totals.calls).toBeGreaterThan(1);
		expect([...buckets.keys.objects.keys()]).toHaveLength(4);
	});

	it("finishes a video folder split across calls", async () => {
		const buckets = await videoBuckets();
		let cursor: string | undefined;
		do {
			const result = await deletePrefixRespectingLocks({
				mediaBucket: buckets.mediaBucket,
				keysBucket: buckets.keysBucket,
				prefix: ROOT,
				cursor,
				batchSize: 1,
				maxSubrequests: 18,
			});
			expect(result.subrequests).toBeLessThanOrEqual(18);
			cursor = result.cursor;
		} while (cursor);
		expect([...buckets.keys.objects.keys()]).toEqual([]);
		expect([...buckets.media.objects.keys()]).toEqual([]);
	});

	it("refuses a bound too small to make progress", async () => {
		const buckets = lockBuckets();
		await expect(
			deletePrefixRespectingLocks({ mediaBucket: buckets.mediaBucket, prefix: ROOT, maxSubrequests: 5 }),
		).rejects.toThrow(RangeError);
	});
});
