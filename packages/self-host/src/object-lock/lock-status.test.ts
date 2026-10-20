import { describe, expect, it } from "vitest";
import { readObjectLock, retainedSummary } from "../index";
import { splitStorageKey } from "./lock-status";
import { compliance, expired, FAR_FUTURE, governance, lockBuckets, ROOT } from "./prefix-test-support";

const RAW = "private/video/v1/raw/clip.mp4";
const SEGMENT = "private/video/v1/hls/seg-0.ts";

describe("splitStorageKey", () => {
	it("reads the storage prefix from the key's first visibility segment", () => {
		expect(splitStorageKey(`${ROOT}private/file/f1/a.pdf`)).toEqual({ root: ROOT, key: "private/file/f1/a.pdf" });
		expect(splitStorageKey("public/asset/site/private/a.css")).toEqual({
			root: "",
			key: "public/asset/site/private/a.css",
		});
		expect(splitStorageKey(`${ROOT}__lock/private/file/f1/a.pdf`)?.key).toBe("__lock/private/file/f1/a.pdf");
	});

	it("uses the root it's given, and refuses keys outside it", () => {
		expect(splitStorageKey("x/public/y/private/f/1/a", "x/public/y/")).toEqual({
			root: "x/public/y/",
			key: "private/f/1/a",
		});
		expect(splitStorageKey("other/private/f/1/a", ROOT)).toBeNull();
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
