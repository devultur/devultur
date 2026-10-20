// Regression tests from the review of the prefix delete: what it must never delete, and the bounds it must keep.
import { describe, expect, it } from "vitest";
import { deletePrefixRespectingLocks, type PrefixDeleteOptions, type PrefixDeleteResult } from "../index";
import { LOCK_CACHE_MAX_USES } from "./lock-status";
import { compliance, lockBuckets, ROOT } from "./prefix-test-support";
import { sidecarKey } from "./sidecar";

type Buckets = ReturnType<typeof lockBuckets>;

/** Calls the delete until it hands back no cursor; every call must stay within its bound. */
async function deleteUntilDone(options: PrefixDeleteOptions, countCalls?: () => number): Promise<PrefixDeleteResult[]> {
	const results: PrefixDeleteResult[] = [];
	let cursor: string | undefined;
	do {
		const before = countCalls?.() ?? 0;
		const result = await deletePrefixRespectingLocks({ ...options, cursor });
		const max = options.maxSubrequests ?? 40;
		expect(result.subrequests).toBeLessThanOrEqual(max);
		if (countCalls) expect(countCalls() - before).toBe(result.subrequests);
		expect(result.cursor).not.toBe("");
		results.push(result);
		cursor = result.cursor;
	} while (cursor);
	return results;
}

/** `bucket` with `intercept` run on every call before it reaches the bucket. */
function intercepted(bucket: R2Bucket, intercept: (method: string, args: unknown[]) => unknown) {
	return new Proxy(bucket, {
		get(target, property) {
			const value = Reflect.get(target, property);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => intercept(String(property), args) ?? value.apply(target, args);
		},
	});
}

const all = (buckets: Buckets, prefix: string) => ({
	mediaBucket: buckets.mediaBucket,
	keysBucket: buckets.keysBucket,
	prefix,
});

describe("what a prefix delete never deletes", () => {
	it("a storage prefix with no trailing slash: lock records stay and the lock is honored", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("public/file/f1/a.pdf", { root: "app1-" });
		await buckets.setSidecar("public/file/f1/a.pdf", { hold: true }, "app1-");
		await buckets.media.put("app1-__lock-audit/2030-01-01/x.json", "{}");

		const [result] = await deleteUntilDone(all(buckets, "app1-"));
		expect(result?.deletedCount).toBe(0);
		expect(result?.retained).toEqual([
			expect.objectContaining({ key: "app1-public/file/f1/a.pdf", unrecognized: true }),
		]);
		expect(result?.skippedCount).toBe(2);
		expect(buckets.media.objects.has(sidecarKey("app1-", "public/file/f1/a.pdf"))).toBe(true);
		expect(buckets.media.objects.has("app1-__lock-audit/2030-01-01/x.json")).toBe(true);
	});

	it("a wrong root: nothing under it is deleted", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("private/file/f1/a.pdf");
		await buckets.setSidecar("private/file/f1/a.pdf", { hold: true });
		const [result] = await deleteUntilDone({ ...all(buckets, ROOT), root: "" });
		expect(result).toMatchObject({ deletedCount: 0, retainedCount: 1, skippedCount: 1 });
		expect(buckets.hasMedia("private/file/f1/a.pdf")).toBe(true);
		expect(buckets.media.objects.has(sidecarKey(ROOT, "private/file/f1/a.pdf"))).toBe(true);
	});

	it("a folder key written after the call started (an upload in flight)", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("private/video/v1/raw/clip.mp4");
		await buckets.keys.put(`${ROOT}private/video/v1/hls/hk1`, "hls key");
		buckets.keys.objects.set(`${ROOT}private/video/v1/raw/next.mp4/k2`, {
			bytes: new Uint8Array(1),
			httpMetadata: {},
			customMetadata: {},
			uploaded: new Date(Date.now() + 60_000),
		});
		await deleteUntilDone(all(buckets, ROOT));
		expect(buckets.hasKey("private/video/v1/hls/hk1")).toBe(false);
		expect(buckets.hasKey("private/video/v1/raw/next.mp4/k2")).toBe(true);
	});

	it("a version that replaced the listed one: it's checked again, and kept when locked", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("private/file/f1/a.pdf", { size: 3 });
		let isReplaced = false;
		const mediaBucket = intercepted(buckets.mediaBucket, (method) => {
			if (method !== "head" || isReplaced) return undefined;
			isReplaced = true;
			return buckets
				.putObject("private/file/f1/a.pdf", { lock: compliance, size: 9 })
				.then(() => buckets.mediaBucket.head(`${ROOT}private/file/f1/a.pdf`));
		});
		const [result] = await deleteUntilDone({ ...all(buckets, ROOT), mediaBucket });
		expect(result?.retained).toEqual([expect.objectContaining({ size: 9, mode: "compliance" })]);
		expect(buckets.hasMedia("private/file/f1/a.pdf")).toBe(true);
	});
});

describe("prefix delete bounds", () => {
	it("counts every call of a video with many raws and never goes past the bound", async () => {
		const buckets = lockBuckets();
		for (let index = 0; index < 10; index += 1) await buckets.putObject(`private/video/v1/raw/r${index}.mp4`);
		for (let index = 0; index < 5; index += 1) await buckets.putObject(`private/video/v1/hls/s${index}.ts`);
		const counted = buckets.countedBuckets();
		const results = await deleteUntilDone({ ...counted, prefix: ROOT }, buckets.callCount);
		expect(results.reduce((total, result) => total + result.deletedCount, 0)).toBe(15);
		expect([...buckets.media.objects.keys()]).toEqual([]);
		expect([...buckets.keys.objects.keys()]).toEqual([]);
	});

	it("reads an inherited lock again within a long folder", async () => {
		const buckets = lockBuckets();
		const segmentCount = LOCK_CACHE_MAX_USES * 2 + 10;
		await buckets.putObject("private/video/v1/raw/clip.mp4", { lock: compliance });
		for (let index = 0; index < segmentCount; index += 1) {
			await buckets.putObject(`private/video/v1/hls/s${String(index).padStart(3, "0")}.ts`);
		}
		let rawReads = 0;
		const mediaBucket = intercepted(buckets.mediaBucket, (method, args) => {
			if (method === "head" && String(args[0]).endsWith("raw/clip.mp4")) rawReads += 1;
			return undefined;
		});
		await deleteUntilDone({ ...all(buckets, ROOT), mediaBucket, maxSubrequests: 1000, batchSize: 1000 });
		expect(rawReads).toBeGreaterThanOrEqual(3);
	});

	it("moves past an empty page R2 marks truncated, and never returns an empty cursor", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("private/file/f1/a.pdf");
		let isFirstList = true;
		const mediaBucket = intercepted(buckets.mediaBucket, (method) => {
			if (method !== "list" || !isFirstList) return undefined;
			isFirstList = false;
			return Promise.resolve({ objects: [], truncated: true, cursor: "0", delimitedPrefixes: [] });
		});
		const results = await deleteUntilDone({ ...all(buckets, ROOT), mediaBucket });
		expect(results.at(-1)?.cursor).toBeUndefined();
		expect(buckets.hasMedia("private/file/f1/a.pdf")).toBe(false);
	});

	it("deletes the variants of an original-only image and keeps the image", async () => {
		const buckets = lockBuckets();
		const originalOnly = { retention: { ...compliance.retention!, derivatives: "original-only" as const } };
		await buckets.putObject("public/image/i1/a.jpg", { lock: originalOnly });
		await buckets.putObject("public/image/i1/a.jpg/__variants/w200.webp");
		await deleteUntilDone(all(buckets, ROOT));
		expect(buckets.hasMedia("public/image/i1/a.jpg")).toBe(true);
		expect(buckets.hasMedia("public/image/i1/a.jpg/__variants/w200.webp")).toBe(false);
		expect(buckets.hasKey("public/image/i1/a.jpg/__variants/w200.webp/k1")).toBe(false);
	});
});
