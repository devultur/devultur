import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerPlugin } from "../plugin";
import type { LockChangeRequest } from "../plugin-hooks";
import type { LockAuditRecord } from "./audit";
import { CAPTION_KEY, lockedFixture, RAW_KEY, RAW_UNTIL } from "./worker-fixture";

const FILE_KEY = "private/file/f1/doc.pdf";
const LATER = "2999-06-01T00:00:00Z";
const SOONER = "2998-01-01T00:00:00Z";

function fixtureWith(plugins: WorkerPlugin[] = []) {
	vi.spyOn(console, "log").mockImplementation(() => {});
	const fixture = lockedFixture({ plugins });
	fixture.mediaBucket.objects.set(FILE_KEY, { bytes: new Uint8Array(4), httpMetadata: {}, customMetadata: {} });
	const put = (key: string, body: Record<string, unknown>) =>
		fixture.send(`/v1/lock/${key}`, { method: "PUT", body: JSON.stringify(body) });
	const get = async (key: string) => (await fixture.send(`/v1/lock/${key}`)).json();
	return { ...fixture, put, get };
}

const approveAll: WorkerPlugin = { name: "approve", authorizeLockChange: () => ({ allow: true }) };

afterEach(() => vi.restoreAllMocks());

describe("GET /v1/lock/:key", () => {
	it("reports the upload lock, or none", async () => {
		const { get } = fixtureWith();
		expect(await get(RAW_KEY)).toEqual({
			key: RAW_KEY,
			mode: "compliance",
			until: "2999-01-01T00:00:00.000Z",
			period: null,
			hold: false,
			derivatives: "inherit",
			source: "upload",
			revision: null,
		});
		expect(await get(FILE_KEY)).toMatchObject({ mode: null, until: null, hold: false, source: "none" });
	});

	it("404s a missing object and 401s without the credential", async () => {
		const { send, app, env } = fixtureWith();
		expect((await send("/v1/lock/private/file/none/x.pdf")).status).toBe(404);
		const anonymous = await app.request(`https://media.example/v1/lock/${RAW_KEY}`, {}, env as never);
		expect(anonymous.status).toBe(401);
	});
});

describe("PUT /v1/lock/:key", () => {
	it("sets a retention on an unlocked object, which the guard then enforces", async () => {
		const { put, get, send, settle, mediaBucket } = fixtureWith();
		const res = await put(FILE_KEY, { mode: "governance", until: LATER });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ mode: "governance", source: "sidecar", revision: 1 });
		expect(await get(FILE_KEY)).toMatchObject({ mode: "governance", until: "2999-06-01T00:00:00.000Z" });

		const deleted = await send(`/v1/media/${FILE_KEY}`, { method: "DELETE" });
		expect(deleted.status).toBe(409);
		await settle();
		expect(mediaBucket.objects.has(FILE_KEY)).toBe(true);
	});

	it("extends a compliance retention, and refuses shortening it or switching to governance", async () => {
		const { put } = fixtureWith([approveAll]);
		expect((await put(RAW_KEY, { until: LATER })).status).toBe(200);
		for (const body of [{ until: SOONER, bypassGovernance: true }, { mode: "governance" }, { remove: true }]) {
			const res = await put(RAW_KEY, body);
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({ code: "compliance_extend_only" });
		}
	});

	it("governance: shortening needs bypassGovernance AND a hook's approval", async () => {
		const plain = fixtureWith();
		await plain.put(FILE_KEY, { mode: "governance", until: LATER });
		const unprivileged = await plain.put(FILE_KEY, { until: SOONER });
		expect(unprivileged.status).toBe(403);
		expect(await unprivileged.json()).toMatchObject({ code: "lock_privilege_required" });
		// No hook installed: asking for the bypass isn't enough (decision 4).
		expect((await plain.put(FILE_KEY, { until: SOONER, bypassGovernance: true })).status).toBe(403);

		const approved = fixtureWith([approveAll]);
		await approved.put(FILE_KEY, { mode: "governance", until: LATER });
		expect((await approved.put(FILE_KEY, { until: SOONER })).status).toBe(403);
		const shortened = await approved.put(FILE_KEY, { until: SOONER, bypassGovernance: true });
		expect(shortened.status).toBe(200);
		expect(await shortened.json()).toMatchObject({ until: "2998-01-01T00:00:00.000Z", revision: 2 });
	});

	it("governance: removal with an approved bypass frees the object", async () => {
		const { put, send } = fixtureWith([approveAll]);
		await put(FILE_KEY, { mode: "governance", until: LATER });
		expect((await put(FILE_KEY, { remove: true, bypassGovernance: true })).status).toBe(200);
		expect((await send(`/v1/media/${FILE_KEY}`, { method: "DELETE" })).status).toBe(204);
	});

	it("passes the change to the hook, and the first refusal wins", async () => {
		const seen: LockChangeRequest[] = [];
		const refuse: WorkerPlugin = {
			name: "refuse",
			authorizeLockChange: (_context, request) => {
				seen.push(request);
				return { allow: false, response: Response.json({ code: "not_today" }, { status: 403 }) };
			},
		};
		const never: WorkerPlugin = { name: "never", authorizeLockChange: () => Promise.reject(new Error("not reached")) };
		const { put } = fixtureWith([refuse, never]);
		const res = await put(RAW_KEY, { until: LATER });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ code: "not_today" });
		expect(seen).toEqual([
			{
				action: "extend",
				keys: [RAW_KEY],
				before: { retention: { mode: "compliance", until: RAW_UNTIL }, hold: false },
				after: { retention: { mode: "compliance", until: LATER, derivatives: "inherit" }, hold: false },
			},
		]);
	});

	it("rejects an invalid change with 400", async () => {
		const { put } = fixtureWith();
		expect((await put(FILE_KEY, { until: LATER })).status).toBe(400);
		expect((await put(FILE_KEY, { mode: "governance", until: LATER, period: 60 })).status).toBe(400);
		expect((await put(FILE_KEY, { mode: "forever", until: LATER })).status).toBe(400);
		expect((await put(FILE_KEY, { mode: "governance", period: 60, days: 1 })).status).toBe(400);
	});

	it("loses a concurrent change cleanly: the sidecar is compare-and-swap", async () => {
		const { put, get, mediaBucket } = fixtureWith();
		const bucket = mediaBucket as unknown as { put: (...args: unknown[]) => Promise<unknown> };
		const realPut = bucket.put;
		// Another change lands between this request's read and its write.
		bucket.put = async (...args) => {
			bucket.put = realPut;
			await realPut(
				`__lock/${RAW_KEY}`,
				JSON.stringify({ revision: 1, objectVersion: "v0", lock: { hold: true }, updatedAt: "" }),
			);
			return realPut(...args);
		};
		const res = await put(RAW_KEY, { until: LATER });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "lock_conflict", key: RAW_KEY });
		expect(await get(RAW_KEY)).toMatchObject({ hold: true, revision: 1 });
	});

	it("ignores a sidecar written for an earlier version of the object", async () => {
		const { put, get, mediaBucket } = fixtureWith();
		await put(FILE_KEY, { mode: "governance", until: LATER });
		await mediaBucket.put(FILE_KEY, "replaced", {});
		expect(await get(FILE_KEY)).toMatchObject({ source: "none", mode: null });
	});
});

describe("lock audit", () => {
	it("records each change, rejection and bypass: a log line, an object and the onLockAudit hook", async () => {
		const records: LockAuditRecord[] = [];
		const hook: WorkerPlugin = { name: "audit", onLockAudit: (_context, record) => void records.push(record) };
		const { put, send, settle, mediaBucket } = fixtureWith([approveAll, hook]);
		await put(FILE_KEY, { mode: "governance", until: LATER });
		await put(FILE_KEY, { until: SOONER, bypassGovernance: true });
		await send(`/v1/media/${CAPTION_KEY}`, { method: "DELETE" });
		await settle();

		expect(records.map((record) => [record.action, record.outcome, record.bypass ?? false])).toEqual([
			["set", "applied", false],
			["shorten", "applied", true],
			["delete_rejected", "rejected", false],
		]);
		expect(records[2]).toMatchObject({ keys: [CAPTION_KEY, RAW_KEY], reason: "retention_active", actor: null });
		const stored = [...mediaBucket.objects.keys()].filter((key) => key.startsWith("__lock-audit/"));
		expect(stored).toHaveLength(3);
		expect(stored[0]).toMatch(/^__lock-audit\/\d{4}-\d{2}-\d{2}\/\d+-[0-9a-f-]{36}\.json$/);
	});
});

describe("delivery headers", () => {
	it("tells the owner when a read object is locked", async () => {
		const { send } = fixtureWith();
		const res = await send(`/v1/media/${RAW_KEY}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-devultur-lock-until")).toBe("2999-01-01T00:00:00.000Z");
		expect((await send(`/v1/media/${CAPTION_KEY}`)).headers.get("x-devultur-lock-until")).toBeNull();
	});
});
