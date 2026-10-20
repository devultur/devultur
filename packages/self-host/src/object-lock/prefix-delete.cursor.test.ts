// The prefix delete only goes where its caller asked: a cursor can't move it, nor a clock.
import { describe, expect, it } from "vitest";
import { deletePrefixRespectingLocks, type PrefixDeleteOptions } from "../index";
import { compliance, lockBuckets, ROOT } from "./prefix-test-support";

const cursorOf = (value: unknown) => btoa(JSON.stringify(value));

async function seeded() {
	const buckets = lockBuckets();
	await buckets.putObject("private/file/f1/a.pdf");
	await buckets.putObject("private/video/v1/raw/clip.mp4", { root: "apps/other/" });
	await buckets.keys.put("apps/other/private/video/v1/hls/hk1", "hls key");
	const options: PrefixDeleteOptions = {
		mediaBucket: buckets.mediaBucket,
		keysBucket: buckets.keysBucket,
		prefix: ROOT,
	};
	const snapshot = () => [...buckets.media.objects.keys(), ...buckets.keys.objects.keys()].sort();
	return { buckets, options, snapshot };
}

describe("a tampered cursor", () => {
	it.each([
		["not base64 JSON", "%%%"],
		["an array", cursorOf([])],
		["another prefix", cursorOf({ prefix: "apps/" })],
		["no prefix", cursorOf({ after: `${ROOT}a` })],
		["a position outside the prefix", cursorOf({ prefix: ROOT, after: "apps/other/z" })],
		["a position that isn't a string", cursorOf({ prefix: ROOT, after: 7 })],
		["an R2 cursor that isn't a string", cursorOf({ prefix: ROOT, listCursor: {} })],
		[
			"a folder that isn't a video folder",
			cursorOf({ prefix: ROOT, folder: { root: ROOT, folder: "private/file/f1" } }),
		],
		[
			"a folder outside the prefix",
			cursorOf({ prefix: ROOT, folder: { root: "apps/other/", folder: "private/video/v1" } }),
		],
		[
			"a folder whose root isn't its storage prefix",
			cursorOf({ prefix: "apps/", folder: { root: "", folder: "apps/other/private/video/v1" } }),
		],
		["a folder with no root", cursorOf({ prefix: ROOT, folder: { folder: "private/video/v1" } })],
	])("throws on %s and deletes nothing", async (_, cursor) => {
		const { options, snapshot } = await seeded();
		const before = snapshot();
		await expect(deletePrefixRespectingLocks({ ...options, cursor })).rejects.toThrow(RangeError);
		expect(snapshot()).toEqual(before);
	});

	it("throws on a listing that strays outside the prefix, before deleting any of the page", async () => {
		const { buckets, options, snapshot } = await seeded();
		const before = snapshot();
		const mediaBucket = new Proxy(buckets.mediaBucket, {
			get(target, property) {
				if (property !== "list") return Reflect.get(target, property);
				return async () => {
					const listing = await buckets.mediaBucket.list({ prefix: "apps/" });
					return { ...listing, truncated: false };
				};
			},
		});
		await expect(deletePrefixRespectingLocks({ ...options, mediaBucket })).rejects.toThrow(RangeError);
		expect(snapshot()).toEqual(before);
	});
});

describe("the clock", () => {
	it("is the real one: a `now` past the retention doesn't free a file", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("private/file/f1/a.pdf", { lock: compliance });
		const options = { mediaBucket: buckets.mediaBucket, prefix: ROOT, now: new Date("3000-01-01T00:00:00Z") };
		const result = await deletePrefixRespectingLocks(options as PrefixDeleteOptions);
		expect(result.retainedCount).toBe(1);
		expect(buckets.hasMedia("private/file/f1/a.pdf")).toBe(true);
	});
});

describe("a video folder reaching outside the prefix", () => {
	it("isn't closed: its other keys and marker aren't the call's to delete", async () => {
		const buckets = lockBuckets();
		await buckets.putObject("private/video/v1/hls/s0.ts");
		await buckets.keys.put(`${ROOT}private/video/v1/hls/hk1`, "hls key");
		const result = await deletePrefixRespectingLocks({
			mediaBucket: buckets.mediaBucket,
			keysBucket: buckets.keysBucket,
			prefix: `${ROOT}private/video/v1/hls/s`,
		});
		expect(result).toMatchObject({ deletedCount: 1 });
		expect(result.cursor).toBeUndefined();
		expect(buckets.hasKey("private/video/v1/hls/hk1")).toBe(true);
	});
});
