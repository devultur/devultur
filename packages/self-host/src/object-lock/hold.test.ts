import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerPlugin } from "../plugin";
import type { LockChangeRequest } from "../plugin-hooks";
import { loggedAudits } from "./audit-test-support";
import { HOLD_PAGE_SIZE } from "./hold";
import { lockedFixture, RAW_KEY } from "./worker-fixture";

const DAY = 86_400;
const empty = () => ({ bytes: new Uint8Array(1), httpMetadata: {}, customMetadata: {} });
const withLock = (lock: unknown) => ({
	...empty(),
	customMetadata: { lock: JSON.stringify(lock) },
	uploaded: new Date(),
});

function fixtureWith(plugins: WorkerPlugin[] = []) {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const fixture = lockedFixture({ plugins });
	const hold = (body: Record<string, unknown>) =>
		fixture.send("/v1/lock/hold", { method: "POST", body: JSON.stringify(body) });
	const lockOf = async (key: string) => (await fixture.send(`/v1/lock/${key}`)).json();
	const remove = (key: string) => fixture.send(`/v1/media/${key}`, { method: "DELETE" });
	return { ...fixture, log, hold, lockOf, remove };
}

afterEach(() => vi.restoreAllMocks());

describe("POST /v1/lock/hold", () => {
	it("holds and releases a list of keys, skipping missing and unchanged ones", async () => {
		const { hold, remove, mediaBucket } = fixtureWith();
		mediaBucket.objects.set("private/file/a/a.pdf", empty());
		mediaBucket.objects.set("private/file/b/b.pdf", empty());
		const keys = ["private/file/a/a.pdf", "private/file/b/b.pdf", "private/file/none/x.pdf"];

		expect(await (await hold({ hold: true, keys })).json()).toEqual({
			updated: keys.slice(0, 2),
			skipped: [{ key: "private/file/none/x.pdf", reason: "not_found" }],
		});
		expect((await remove("private/file/a/a.pdf")).status).toBe(409);
		expect(await (await hold({ hold: true, keys: ["private/file/a/a.pdf"] })).json()).toMatchObject({
			skipped: [{ key: "private/file/a/a.pdf", reason: "unchanged" }],
		});

		await hold({ hold: false, keys: keys.slice(0, 2) });
		// No retention: released means free.
		expect((await remove("private/file/a/a.pdf")).status).toBe(204);
	});

	it("walks a prefix a page at a time with a cursor", async () => {
		const { hold, mediaBucket } = fixtureWith();
		const keys = Array.from(
			{ length: HOLD_PAGE_SIZE + 5 },
			(_, index) => `private/asset/batch/${String(index).padStart(3, "0")}.bin`,
		);
		for (const key of keys) mediaBucket.objects.set(key, empty());
		mediaBucket.objects.set("private/asset/batch/000.bin/__variants/w100.webp", empty());

		const first = (await (await hold({ hold: true, prefix: "private/asset/batch/" })).json()) as {
			updated: string[];
			cursor?: string;
		};
		expect(first.cursor).toBeDefined();
		const second = (await (
			await hold({ hold: true, prefix: "private/asset/batch/", cursor: first.cursor })
		).json()) as {
			updated: string[];
			cursor?: string;
		};
		expect(second.cursor).toBeUndefined();
		// Every object once; the image variant (a regenerable cache) never.
		expect([...first.updated, ...second.updated].sort()).toEqual(keys);
	});

	it("release with a period starts it at release time", async () => {
		const { hold, lockOf, mediaBucket } = fixtureWith();
		const key = "private/file/p/p.pdf";
		mediaBucket.objects.set(key, withLock({ retention: { mode: "compliance", period: 30 * DAY }, hold: true }));
		expect(await lockOf(key)).toMatchObject({ hold: true, until: null, period: 30 * DAY });

		const before = Date.now();
		await hold({ hold: false, keys: [key] });
		const until = Date.parse(((await lockOf(key)) as { until: string }).until);
		expect(until).toBeGreaterThanOrEqual(before + 30 * DAY * 1000);
		expect(until).toBeLessThanOrEqual(Date.now() + 30 * DAY * 1000);
	});

	it("a hold on a compliance object keeps its date, and only extends protection", async () => {
		const { hold, lockOf } = fixtureWith();
		await hold({ hold: true, keys: [RAW_KEY] });
		expect(await lockOf(RAW_KEY)).toMatchObject({ mode: "compliance", until: "2999-01-01T00:00:00.000Z", hold: true });
		await hold({ hold: false, keys: [RAW_KEY] });
		expect(await lockOf(RAW_KEY)).toMatchObject({ until: "2999-01-01T00:00:00.000Z", hold: false });
	});

	it("goes through authorizeLockChange once per page, and the first refusal wins", async () => {
		const seen: LockChangeRequest[] = [];
		const gate: WorkerPlugin = {
			name: "gate",
			authorizeLockChange: (_context, request) => {
				seen.push(request);
				return request.action === "release"
					? { allow: false, response: Response.json({ code: "legal_says_no" }, { status: 403 }) }
					: { allow: true };
			},
		};
		const { hold } = fixtureWith([gate]);
		expect((await hold({ hold: true, keys: [RAW_KEY] })).status).toBe(200);
		const refused = await hold({ hold: false, keys: [RAW_KEY] });
		expect(refused.status).toBe(403);
		expect(seen).toEqual([
			{ action: "hold", keys: [RAW_KEY], before: null, after: { hold: true } },
			{ action: "release", keys: [RAW_KEY], before: null, after: { hold: false } },
		]);
	});

	it("audits each object it changes", async () => {
		const { hold, log } = fixtureWith();
		await hold({ hold: true, keys: [RAW_KEY] });
		expect(loggedAudits(log)).toEqual([
			expect.objectContaining({
				action: "hold",
				keys: [RAW_KEY],
				outcome: "applied",
				after: expect.objectContaining({ hold: true }),
			}),
		]);
	});

	it("skips an object whose lock changed concurrently (sidecar compare-and-swap)", async () => {
		const { hold, lockOf, mediaBucket } = fixtureWith();
		const bucket = mediaBucket as unknown as { put: (...args: unknown[]) => Promise<unknown> };
		const realPut = bucket.put;
		bucket.put = async (...args) => {
			bucket.put = realPut;
			const winner = { revision: 1, objectVersion: "v0", lock: { hold: true }, updatedAt: "" };
			await realPut(`__lock/${RAW_KEY}`, JSON.stringify(winner));
			return realPut(...args);
		};
		expect(await (await hold({ hold: true, keys: [RAW_KEY] })).json()).toEqual({
			updated: [],
			skipped: [{ key: RAW_KEY, reason: "lock_conflict" }],
		});
		expect(await lockOf(RAW_KEY)).toMatchObject({ revision: 1 });
	});

	it.each([
		[{ keys: [RAW_KEY] }],
		[{ hold: true }],
		[{ hold: true, keys: [RAW_KEY], prefix: "private/" }],
		[{ hold: true, keys: [] }],
		[{ hold: true, keys: Array.from({ length: HOLD_PAGE_SIZE + 1 }, (_, i) => `k${i}`) }],
		[{ hold: true, prefix: "__lock/" }],
	])("rejects %j with 400", async (body) => {
		const { hold } = fixtureWith();
		expect((await hold(body)).status).toBe(400);
	});

	it("PUT /v1/lock/:key doesn't take a hold: holds have one way in", async () => {
		const { send } = fixtureWith();
		const res = await send(`/v1/lock/${RAW_KEY}`, { method: "PUT", body: JSON.stringify({ hold: true }) });
		expect(res.status).toBe(400);
	});

	it("covers a hold set at upload: kept until released here, and its first write is audited", async () => {
		const { send, hold, remove, log, settle, mediaBucket } = fixtureWith();
		const created = await send("/v1/upload", {
			method: "POST",
			body: JSON.stringify({ filename: "deed.pdf", contentType: "application/pdf", hold: true }),
		});
		const { key, uploadUrl } = (await created.json()) as { key: string; uploadUrl: string };
		const put = await send(uploadUrl, { method: "PUT", body: "pdf", headers: { "Content-Type": "application/pdf" } });
		expect(put.status).toBe(200);
		await settle();

		expect(loggedAudits(log)).toEqual([
			expect.objectContaining({ action: "set", keys: [key], before: null, after: { hold: true }, outcome: "applied" }),
		]);
		expect([...mediaBucket.objects.keys()].some((stored) => stored.startsWith("__lock-audit/"))).toBe(true);
		expect((await remove(key)).status).toBe(409);
		await hold({ hold: false, keys: [key] });
		expect((await remove(key)).status).toBe(204);
	});
});
