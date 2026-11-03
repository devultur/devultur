import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadGrantPath, type DownloadGrantRecord, DownloadGrants, fitsLinkCaps } from "./download-grants";
import { memoryDurableState } from "./exports-test-harness";

const NOW = 1_800_000_000_000;
const SECRET_HASH = "a".repeat(64);

function grantRecord(
	overrides: Partial<DownloadGrantRecord> = {},
): Omit<DownloadGrantRecord, "linksIssued" | "revokedAt"> {
	return {
		id: "grant-1",
		secretHash: SECRET_HASH,
		storageKey: "prefix-a/private/asset/exports/bundle.zip",
		key: "private/asset/exports/bundle.zip",
		version: "v1",
		storagePrefix: "prefix-a/",
		expiresAt: NOW + 60_000,
		link: { maxExpiresIn: 300, maxUses: 1 },
		maxLinks: 2,
		canDelete: false,
		createdAt: NOW,
		...overrides,
	};
}

function grantsObject() {
	const state = memoryDurableState();
	const grants = new DownloadGrants(state);
	const call = (path: string, body: unknown = {}) =>
		grants.fetch(new Request(`https://download-grants${path}`, { method: "POST", body: JSON.stringify(body) }));
	return { state, grants, call };
}

const credential = { id: "grant-1", secretHash: SECRET_HASH };
const shortLink = { ...credential, expiresIn: 300, maxUses: 1 };

afterEach(() => {
	vi.useRealTimers();
});

describe("DownloadGrants", () => {
	it("stores a grant once and schedules its expiry", async () => {
		const { state, call } = grantsObject();
		expect((await call(DownloadGrantPath.CREATE, grantRecord())).status).toBe(201);
		expect((await call(DownloadGrantPath.CREATE, grantRecord())).status).toBe(409);
		expect(state.storage.alarm).toBe(NOW + 60_000);
	});

	it("authorizes only the matching secret hash and never returns it", async () => {
		vi.useFakeTimers({ now: NOW });
		const { call } = grantsObject();
		await call(DownloadGrantPath.CREATE, grantRecord({ metadata: { exportId: "42" } }));

		const authorized = await call(DownloadGrantPath.AUTHORIZE, credential);
		expect(authorized.status).toBe(200);
		const info = (await authorized.json()) as Record<string, unknown>;
		expect(info).toMatchObject({ id: "grant-1", linksIssued: 0, revokedAt: null, metadata: { exportId: "42" } });
		expect(info).not.toHaveProperty("secretHash");

		const wrong = await call(DownloadGrantPath.AUTHORIZE, { id: "grant-1", secretHash: "b".repeat(64) });
		expect(wrong.status).toBe(401);
		expect(await wrong.json()).toMatchObject({ code: "invalid_grant" });
		expect((await call(DownloadGrantPath.AUTHORIZE, { id: "other", secretHash: SECRET_HASH })).status).toBe(401);
	});

	it("answers 410 grant_gone once the grant expires", async () => {
		vi.useFakeTimers({ now: NOW });
		const { call } = grantsObject();
		await call(DownloadGrantPath.CREATE, grantRecord());
		vi.setSystemTime(NOW + 60_000);
		const expired = await call(DownloadGrantPath.ISSUE, shortLink);
		expect(expired.status).toBe(410);
		expect(await expired.json()).toMatchObject({ code: "grant_gone" });
	});

	it("refuses a link over the caps without spending one", async () => {
		vi.useFakeTimers({ now: NOW });
		const { call } = grantsObject();
		await call(DownloadGrantPath.CREATE, grantRecord());

		const tooLong = await call(DownloadGrantPath.ISSUE, { ...shortLink, expiresIn: 301 });
		expect(tooLong.status).toBe(400);
		expect(await tooLong.json()).toMatchObject({ code: "link_exceeds_grant", link: { maxExpiresIn: 300, maxUses: 1 } });
		expect((await call(DownloadGrantPath.ISSUE, { ...shortLink, maxUses: 2 })).status).toBe(400);

		const issued = await call(DownloadGrantPath.ISSUE, shortLink);
		expect(await issued.json()).toMatchObject({ linksIssued: 1 });
	});

	it("issues exactly maxLinks links under concurrent requests", async () => {
		vi.useFakeTimers({ now: NOW });
		const { call } = grantsObject();
		await call(DownloadGrantPath.CREATE, grantRecord({ maxLinks: 5 }));

		const responses = await Promise.all(Array.from({ length: 6 }, () => call(DownloadGrantPath.ISSUE, shortLink)));
		const statuses = responses.map((response) => response.status);
		expect(statuses.filter((status) => status === 200)).toHaveLength(5);
		expect(statuses.filter((status) => status === 410)).toHaveLength(1);
		const exhausted = responses.find((response) => response.status === 410);
		expect(await exhausted?.json()).toMatchObject({ code: "grant_exhausted" });
	});

	it("gives a link back when its creation failed", async () => {
		vi.useFakeTimers({ now: NOW });
		const { call } = grantsObject();
		await call(DownloadGrantPath.CREATE, grantRecord({ maxLinks: 1 }));
		await call(DownloadGrantPath.ISSUE, shortLink);
		expect((await call(DownloadGrantPath.REFUND, { id: "grant-1" })).status).toBe(204);
		expect((await call(DownloadGrantPath.ISSUE, shortLink)).status).toBe(200);
	});

	it("revokes by id (owner) or by its own secret (bearer), idempotently", async () => {
		vi.useFakeTimers({ now: NOW });
		const { call } = grantsObject();
		await call(DownloadGrantPath.CREATE, grantRecord());
		await call(DownloadGrantPath.CREATE, grantRecord({ id: "grant-2" }));

		expect((await call(DownloadGrantPath.REVOKE, { id: "grant-1", secretHash: "b".repeat(64) })).status).toBe(401);
		const byBearer = await call(DownloadGrantPath.REVOKE, credential);
		expect(await byBearer.json()).toMatchObject({ id: "grant-1", revokedAt: NOW });
		vi.setSystemTime(NOW + 1);
		expect(await (await call(DownloadGrantPath.REVOKE, credential)).json()).toMatchObject({ revokedAt: NOW });
		expect((await call(DownloadGrantPath.AUTHORIZE, credential)).status).toBe(410);

		const byOwner = await call(DownloadGrantPath.REVOKE, { id: "grant-2" });
		expect(await byOwner.json()).toMatchObject({ id: "grant-2", revokedAt: NOW + 1 });
		expect((await call(DownloadGrantPath.REVOKE, { id: "missing" })).status).toBe(404);
	});

	it("lists every grant of the file, oldest first, without secrets", async () => {
		const { call } = grantsObject();
		await call(DownloadGrantPath.CREATE, grantRecord({ id: "late", createdAt: NOW + 5 }));
		await call(DownloadGrantPath.CREATE, grantRecord({ id: "early" }));
		const listed = (await (await call(DownloadGrantPath.LIST)).json()) as Array<Record<string, unknown>>;
		expect(listed.map((grant) => grant.id)).toEqual(["early", "late"]);
		expect(listed.every((grant) => !("secretHash" in grant))).toBe(true);
		expect(await (await call(DownloadGrantPath.GET, { id: "late" })).json()).toMatchObject({ id: "late" });
	});

	it("drops expired grants on the alarm and schedules the next expiry", async () => {
		vi.useFakeTimers({ now: NOW });
		const { state, grants, call } = grantsObject();
		await call(DownloadGrantPath.CREATE, grantRecord({ id: "soon", expiresAt: NOW + 1_000 }));
		await call(DownloadGrantPath.CREATE, grantRecord({ id: "later", expiresAt: NOW + 5_000 }));
		expect(state.storage.alarm).toBe(NOW + 1_000);

		vi.setSystemTime(NOW + 1_000);
		await grants.alarm();
		const listed = (await (await call(DownloadGrantPath.LIST)).json()) as Array<{ id: string }>;
		expect(listed.map((grant) => grant.id)).toEqual(["later"]);
		expect(state.storage.alarm).toBe(NOW + 5_000);

		vi.setSystemTime(NOW + 5_000);
		await grants.alarm();
		expect(state.storage.alarm).toBeUndefined();
	});

	it("revokes every grant when the file is gone, keeping them listed until they expire", async () => {
		vi.useFakeTimers({ now: NOW });
		const { state, call } = grantsObject();
		await call(DownloadGrantPath.CREATE, grantRecord());
		await call(DownloadGrantPath.CREATE, grantRecord({ id: "grant-2" }));
		expect((await call(DownloadGrantPath.REVOKE_ALL)).status).toBe(204);
		const listed = (await (await call(DownloadGrantPath.LIST)).json()) as Array<{ revokedAt: number | null }>;
		expect(listed.map((grant) => grant.revokedAt)).toEqual([NOW, NOW]);
		expect((await call(DownloadGrantPath.AUTHORIZE, credential)).status).toBe(410);
		expect(state.storage.alarm).toBe(NOW + 60_000);
	});

	it("only answers POST on known paths", async () => {
		const { grants } = grantsObject();
		expect((await grants.fetch(new Request("https://download-grants/list"))).status).toBe(405);
		expect((await grants.fetch(new Request("https://download-grants/nope", { method: "POST" }))).status).toBe(404);
	});
});

describe("fitsLinkCaps", () => {
	it("accepts links up to the caps", () => {
		expect(fitsLinkCaps({ maxExpiresIn: 300, maxUses: 2 }, 300, 2)).toBe(true);
		expect(fitsLinkCaps({ maxExpiresIn: 300, maxUses: 2 }, 300, 3)).toBe(false);
	});
});
