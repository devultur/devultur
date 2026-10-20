import { describe, expect, it } from "vitest";
import { readObjectLock, retainedSummary } from "../index";
import { placeOfStorageKey } from "./lock-status";
import { compliance, expired, FAR_FUTURE, governance, lockBuckets, ROOT } from "./prefix-test-support";

const RAW = "private/video/v1/raw/clip.mp4";
const SEGMENT = "private/video/v1/hls/seg-0.ts";

describe("placeOfStorageKey", () => {
	it("reads the storage prefix from the key's first visibility segment", () => {
		expect(placeOfStorageKey(`${ROOT}private/file/f1/a.pdf`)).toEqual({
			kind: "object",
			root: ROOT,
			key: "private/file/f1/a.pdf",
		});
		expect(placeOfStorageKey("public/asset/site/private/a.css")).toEqual({
			kind: "object",
			root: "",
			key: "public/asset/site/private/a.css",
		});
	});

	it("uses the root it's given", () => {
		expect(placeOfStorageKey("x/public/y/private/f/1/a", "x/public/y/")).toEqual({
			kind: "object",
			root: "x/public/y/",
			key: "private/f/1/a",
		});
	});

	// Regression: a key with no visibility segment used to fall back to root "", which put lock records in reach.
	it.each([
		`${ROOT}__lock/private/file/f1/a.pdf`,
		`${ROOT}__lock-audit/2030-01-01/x.json`,
		"app1-__lock/public/file/f1/a.pdf",
		"app1-__lock-audit/2030-01-01/x.json",
		"__lock/public/file/f1/a.pdf",
	])("never treats %s as an object", (key) => {
		expect(placeOfStorageKey(key).kind).toBe("reserved");
		expect(placeOfStorageKey(key, "").kind).toBe("reserved");
	});

	it.each([
		["app1-public/file/f1/a.pdf", undefined],
		["other/private/f/1/a", ROOT],
		[`${ROOT}private/file/f1/a.pdf`, ""],
	])("doesn't recognize %s (root %s)", (key, root) => {
		expect(placeOfStorageKey(key, root)).toEqual({ kind: "unrecognized" });
	});
});

describe("readObjectLock", () => {
	it("reads the upload lock and a sidecar bound to the current version", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("private/file/f1/a.pdf", { lock: compliance });
		await buckets.putObject("private/file/f2/b.pdf");
		await buckets.setSidecar("private/file/f2/b.pdf", { hold: true });
		const options = { mediaBucket: buckets.mediaBucket };

		expect(await readObjectLock(options, `${ROOT}private/file/f1/a.pdf`)).toEqual({
			locked: true,
			hold: false,
			until: new Date(FAR_FUTURE).toISOString(),
			mode: "compliance",
		});
		expect(await readObjectLock(options, `${ROOT}private/file/f2/b.pdf`)).toEqual({ locked: true, hold: true });
		expect(await readObjectLock(options, `${ROOT}private/file/missing.pdf`)).toBeNull();
	});

	it("ignores a sidecar left by a previous version", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("private/file/f1/a.pdf");
		await buckets.setSidecar("private/file/f1/a.pdf", { hold: true });
		await buckets.putObject("private/file/f1/a.pdf");
		const lock = await readObjectLock({ mediaBucket: buckets.mediaBucket }, `${ROOT}private/file/f1/a.pdf`);
		expect(lock).toEqual({ locked: false, hold: false });
	});

	it("reads an unreadable record as held", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("private/file/f1/a.pdf");
		await buckets.corruptSidecar("private/file/f1/a.pdf");
		const lock = await readObjectLock({ mediaBucket: buckets.mediaBucket }, `${ROOT}private/file/f1/a.pdf`);
		expect(lock).toEqual({ locked: true, hold: true, unreadable: true });
	});

	it("locks a video's derived files by its raw unless the raw is original-only", async () => {
		const buckets = lockBuckets();
		await buckets.putObject(RAW, { lock: governance });
		await buckets.putObject(SEGMENT);
		const options = { mediaBucket: buckets.mediaBucket };
		expect(await readObjectLock(options, `${ROOT}${SEGMENT}`)).toMatchObject({
			locked: true,
			mode: "governance",
			lockedBy: `${ROOT}${RAW}`,
		});

		await buckets.setSidecar(RAW, { retention: { ...compliance.retention!, derivatives: "original-only" } });
		expect(await readObjectLock(options, `${ROOT}${SEGMENT}`)).toEqual({ locked: false, hold: false });
		expect(await readObjectLock(options, `${ROOT}${RAW}`)).toMatchObject({ locked: true, mode: "compliance" });
	});

	it("locks an image variant by its original", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("public/image/i1/a.jpg", { lock: compliance });
		await buckets.putObject("public/image/i1/a.jpg/__variants/w200.webp");
		const lock = await readObjectLock(
			{ mediaBucket: buckets.mediaBucket },
			`${ROOT}public/image/i1/a.jpg/__variants/w200.webp`,
		);
		expect(lock).toMatchObject({ locked: true, lockedBy: `${ROOT}public/image/i1/a.jpg` });
	});

	it("frees the variants of an original-only image, like the delete route", async () => {
		const buckets = lockBuckets();
		const originalOnly = { retention: { ...compliance.retention!, derivatives: "original-only" as const } };
		await buckets.putObject("public/image/i1/a.jpg", { lock: originalOnly });
		await buckets.putObject("public/image/i1/a.jpg/__variants/w200.webp");
		const options = { mediaBucket: buckets.mediaBucket };
		expect(await readObjectLock(options, `${ROOT}public/image/i1/a.jpg/__variants/w200.webp`)).toEqual({
			locked: false,
			hold: false,
		});
		expect(await readObjectLock(options, `${ROOT}public/image/i1/a.jpg`)).toMatchObject({ locked: true });
	});

	it("keeps a key it can't place, and reads no lock record as an object", async () => {
		const buckets = lockBuckets();
		await buckets.media.put("app1-public/file/f1/a.pdf", "x");
		await buckets.media.put("app1-__lock/public/file/f1/a.pdf", "{}");
		const options = { mediaBucket: buckets.mediaBucket };
		expect(await readObjectLock(options, "app1-public/file/f1/a.pdf")).toMatchObject({
			locked: true,
			unrecognized: true,
		});
		expect(await readObjectLock(options, "app1-__lock/public/file/f1/a.pdf")).toBeNull();
	});
});

describe("retainedSummary", () => {
	it("counts what's retained, its latest end and any hold, without deleting", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("private/file/f1/a.pdf", { lock: compliance, size: 3 });
		await buckets.putObject("private/file/f2/b.pdf", { lock: expired });
		await buckets.putObject("private/file/f3/c.pdf", { lock: { hold: true }, size: 5 });
		await buckets.putObject("private/file/f4/d.pdf");

		const summary = await retainedSummary({ mediaBucket: buckets.mediaBucket, prefix: ROOT });
		expect(summary).toMatchObject({
			scannedCount: 4,
			retainedCount: 2,
			retainedBytes: 8,
			latestUntil: new Date(FAR_FUTURE).toISOString(),
			hasHold: true,
		});
		expect(summary.cursor).toBeUndefined();
		expect(buckets.hasMedia("private/file/f4/d.pdf")).toBe(true);
	});

	it("resumes from its cursor within its subrequest bound", async () => {
		const buckets = lockBuckets();
		for (let index = 0; index < 12; index += 1) {
			await buckets.putObject(`private/file/f${index}/a.pdf`, { lock: index % 3 === 0 ? compliance : undefined });
		}
		let cursor: string | undefined;
		let retainedCount = 0;
		let calls = 0;
		do {
			const summary = await retainedSummary({
				mediaBucket: buckets.mediaBucket,
				prefix: ROOT,
				cursor,
				maxSubrequests: 10,
			});
			expect(summary.subrequests).toBeLessThanOrEqual(10);
			retainedCount += summary.retainedCount;
			cursor = summary.cursor;
			calls += 1;
		} while (cursor);
		expect(retainedCount).toBe(4);
		expect(calls).toBeGreaterThan(1);
	});
});
