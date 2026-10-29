import type { WebhookEvent } from "@devultur/core";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportsWorker } from "../exports-test-harness";
import type { CredentialRequest, GrantAccessRequest, PluginHooks } from "../plugin-hooks";
import { getRouteResult, type RouteResult } from "../route-result";
import { withSignature } from "../test-fixtures";
import type { WorkerApp } from "../types";
import { identifyDownloadGrant } from "./grant-bearer";

// Download grants end to end over the in-memory Worker: the owner issues, lists and revokes; the bearer reads the head,
// issues links within the caps, deletes the file when allowed and revokes itself. Never through a URL.

const BYTES = withSignature("application/zip", "zip bytes");
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const GRANT_PATTERN = /^dvg_[0-9a-f]{64}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const PUBLIC_ID_PATTERN = /^dgr_[0-9a-f]{64}\.[A-Za-z0-9_-]{22}$/;

type Worker = ReturnType<typeof exportsWorker>;

interface IssuedGrant {
	grant: string;
	id: string;
	key: string;
	expiresAt: number;
	link: { maxExpiresIn: number; maxUses: number };
	maxLinks: number;
	canDelete: boolean;
	metadata?: Record<string, string>;
}

const noHooks: PluginHooks = {
	issueCredential: [],
	beforeLinkRedeem: [],
	authorizeGrant: [],
	authorizeLockChange: [],
	onLockAudit: [],
	onMediaEvent: [],
	resolveWebhookTarget: [],
};

async function uploadAsset(worker: Worker, body: Record<string, unknown>): Promise<string> {
	const created = await worker.postJson("/v1/upload", { contentType: "application/zip", ...body });
	const { key, uploadUrl } = (await created.json()) as { key: string; uploadUrl: string };
	await worker.send(uploadUrl, { method: "PUT", body: BYTES, headers: { "Content-Type": "application/zip" } });
	return key;
}

async function issueGrant(worker: Worker, body: Record<string, unknown>) {
	const res = await worker.postJson("/v1/token/grant", body);
	return { res, issued: (await res.clone().json()) as IssuedGrant };
}

const bearer = (grant: string) => ({ Authorization: `Bearer ${grant}` });
const headFile = (worker: Worker, grant: string) =>
	worker.send("/v1/grant/file", { method: "HEAD", headers: bearer(grant) });
const issueLink = (worker: Worker, grant: string, body: Record<string, unknown> = {}) =>
	worker.postJson("/v1/grant/links", body, bearer(grant));

/** The Worker behind an outer app that records each request's route result. */
function recordingWorker(options: Parameters<typeof exportsWorker>[0] = {}) {
	const results: RouteResult[] = [];
	const inner = exportsWorker(options);
	const outer = new Hono<WorkerApp>();
	outer.use("*", async (context, next) => {
		await next();
		results.push(getRouteResult(context));
	});
	outer.route("/", inner.app);
	const send = (path: string, init: RequestInit = {}) => outer.request(`http://worker${path}`, init, inner.env);
	const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
		send(path, {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "Content-Type": "application/json", ...headers },
		});
	return { worker: { ...inner, send, postJson }, results };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("issuing a download grant", () => {
	it("returns the secret once, its public id and the default caps, for the life of the file", async () => {
		vi.useFakeTimers({ now: NOW });
		const worker = exportsWorker({ context: { owner: "a" } });
		const key = await uploadAsset(worker, { path: "exports/bundle.zip", expiresIn: 7 * 24 * 60 * 60 });
		const { res, issued } = await issueGrant(worker, { key, metadata: { exportId: "42" } });

		expect(res.status).toBe(200);
		expect(issued.grant).toMatch(GRANT_PATTERN);
		expect(issued.id).toMatch(PUBLIC_ID_PATTERN);
		expect(issued).toMatchObject({
			key,
			expiresAt: NOW + 7 * DAY_MS,
			link: { maxExpiresIn: 900, maxUses: 1 },
			maxLinks: 20,
			canDelete: false,
			metadata: { exportId: "42" },
		});
	});

	it("caps a grant at 30 days for a file without a TTL, and at the file's expiry", async () => {
		vi.useFakeTimers({ now: NOW });
		const worker = exportsWorker();
		const forever = await uploadAsset(worker, { path: "exports/forever.zip" });
		expect((await issueGrant(worker, { key: forever })).issued.expiresAt).toBe(NOW + 30 * DAY_MS);
		expect((await issueGrant(worker, { key: forever, expiresIn: 60 })).issued.expiresAt).toBe(NOW + 60_000);

		const weekly = await uploadAsset(worker, { path: "exports/weekly.zip", expiresIn: 7 * 24 * 60 * 60 });
		const clipped = await issueGrant(worker, { key: weekly, expiresIn: 30 * 24 * 60 * 60 });
		expect(clipped.issued.expiresAt).toBe(NOW + 7 * DAY_MS);
	});

	it("validates the caps and the metadata", async () => {
		const worker = exportsWorker();
		const key = await uploadAsset(worker, { path: "exports/caps.zip" });
		const codeOf = async (body: Record<string, unknown>) =>
			((await issueGrant(worker, body)).issued as never as { code: string }).code;
		expect(await codeOf({ key, link: { maxExpiresIn: 86_401 } })).toBe("invalid_link_caps");
		expect(await codeOf({ key, link: { maxUses: 11 } })).toBe("invalid_link_caps");
		expect(await codeOf({ key, maxLinks: 101 })).toBe("invalid_max_links");
		expect(await codeOf({ key, canDelete: "yes" })).toBe("invalid_can_delete");
		expect(await codeOf({ key, metadata: { count: 1 } })).toBe("invalid_metadata");
		expect(await codeOf({ key, metadata: { blob: "x".repeat(1100) } })).toBe("invalid_metadata");
		expect(await codeOf({ key: "../escape" })).toBe("invalid_key");
		expect((await issueGrant(worker, { key: "private/asset/exports/missing.zip" })).res.status).toBe(404);
	});

	it("asks the issueCredential hooks, which may shorten it", async () => {
		vi.useFakeTimers({ now: NOW });
		const requests: CredentialRequest[] = [];
		const pluginHooks: PluginHooks = {
			...noHooks,
			issueCredential: [
				(_context, request) => {
					requests.push(request);
					return { allow: true, expiresAt: NOW + 1_000 };
				},
			],
		};
		const worker = exportsWorker({ pluginHooks });
		const key = await uploadAsset(worker, { path: "exports/hooked.zip" });
		const { issued } = await issueGrant(worker, { key, canDelete: true });
		expect(issued.expiresAt).toBe(NOW + 1_000);
		expect(requests[0]).toMatchObject({ kind: "download-grant", scopes: ["media:read", "media:delete"], path: key });
	});
});

describe("the grant's bearer", () => {
	it("reads the head with the grant's expiry and metadata, never the bytes", async () => {
		const worker = exportsWorker();
		const key = await uploadAsset(worker, { path: "exports/head.zip" });
		const { issued } = await issueGrant(worker, { key, metadata: { exportId: "42" } });

		const head = await headFile(worker, issued.grant);
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe(String(BYTES.byteLength));
		expect(head.headers.get("x-devultur-sha256")).toMatch(/^[0-9a-f]{64}$/);
		expect(head.headers.get("x-devultur-encrypted")).toBe("false");
		expect(head.headers.get("x-devultur-grant-expires-at")).toBe(String(issued.expiresAt));
		expect(JSON.parse(decodeURIComponent(head.headers.get("x-devultur-grant-metadata") ?? ""))).toEqual({
			exportId: "42",
		});
		expect((await worker.send("/v1/grant/file", { headers: bearer(issued.grant) })).status).toBe(405);
	});

	it("says whether the file is encrypted at rest", async () => {
		const worker = exportsWorker({ security: { encrypt: true } });
		const key = await uploadAsset(worker, { path: "exports/sealed.zip" });
		const { issued } = await issueGrant(worker, { key });
		expect((await headFile(worker, issued.grant)).headers.get("x-devultur-encrypted")).toBe("true");
	});

	it("issues links within the caps, each with its own id and none carrying the grant", async () => {
		const worker = exportsWorker();
		const key = await uploadAsset(worker, { path: "exports/links.zip" });
		const { issued } = await issueGrant(worker, { key, link: { maxExpiresIn: 300, maxUses: 1 }, maxLinks: 2 });

		const over = await issueLink(worker, issued.grant, { expiresIn: 301 });
		expect(over.status).toBe(400);
		expect(await over.json()).toMatchObject({ code: "link_exceeds_grant" });
		expect((await issueLink(worker, issued.grant, { maxUses: 2 })).status).toBe(400);

		const first = await issueLink(worker, issued.grant, { expiresIn: 300, filename: "export.zip" });
		expect(first.status).toBe(200);
		const link = (await first.json()) as { id: string; url: string; maxUses: number };
		expect(link.url).toBe(`http://worker/v1/download/${link.id}`);
		expect(JSON.stringify(link)).not.toContain(issued.grant.split(".")[2]);
		const redeemed = await worker.send(new URL(link.url).pathname);
		expect(redeemed.status).toBe(200);
		expect(redeemed.headers.get("content-disposition")).toContain("export.zip");
		expect(new Uint8Array(await redeemed.arrayBuffer())).toEqual(BYTES);

		expect((await issueLink(worker, issued.grant)).status).toBe(200);
		const exhausted = await issueLink(worker, issued.grant);
		expect(exhausted.status).toBe(410);
		expect(await exhausted.json()).toMatchObject({ code: "grant_exhausted" });
	});

	it("issues exactly maxLinks links under concurrent requests", async () => {
		const worker = exportsWorker();
		const key = await uploadAsset(worker, { path: "exports/race.zip" });
		const { issued } = await issueGrant(worker, { key, maxLinks: 3 });
		const statuses = await Promise.all(Array.from({ length: 4 }, () => issueLink(worker, issued.grant)));
		expect(statuses.map((res) => res.status).sort()).toEqual([200, 200, 200, 410]);
	});

	it("stores the grant's context and the link's metadata on each link", async () => {
		const worker = exportsWorker({ context: { owner: "a" } });
		const key = await uploadAsset(worker, { path: "exports/context.zip" });
		const { issued } = await issueGrant(worker, { key });
		const link = (await (await issueLink(worker, issued.grant, { metadata: { ownerId: "u1" } })).json()) as {
			id: string;
		};
		const stored = await worker.links.get(link.id).fetch("https://download-link/peek", { method: "POST" });
		expect(await stored.json()).toMatchObject({
			context: { owner: "a" },
			grantId: issued.id,
			metadata: { ownerId: "u1" },
		});
	});

	it("only accepts the grant in Authorization: Bearer", async () => {
		const worker = exportsWorker();
		const key = await uploadAsset(worker, { path: "exports/query.zip" });
		const { issued } = await issueGrant(worker, { key });

		const inQuery = await worker.send(`/v1/grant/file?token=${issued.grant}`, { method: "HEAD" });
		expect(inQuery.status).toBe(401);
		const inQueryLink = await worker.postJson(`/v1/grant/links?token=${issued.grant}`, {});
		expect(await inQueryLink.json()).toMatchObject({ code: "grant_in_query" });
		expect((await worker.send(`/v1/grant/${issued.grant}`, { method: "HEAD" })).status).toBe(404);
		expect((await headFile(worker, "dvg_nope")).status).toBe(401);
		const forged = issued.grant.replace(/.$/, (last) => (last === "A" ? "B" : "A"));
		expect((await headFile(worker, forged)).status).toBe(401);
	});

	it("answers grant_gone once the file is deleted, expires or is overwritten", async () => {
		vi.useFakeTimers({ now: NOW });
		const worker = exportsWorker();
		const deleted = await uploadAsset(worker, { path: "exports/deleted.zip" });
		const expiring = await uploadAsset(worker, { path: "exports/expiring.zip", expiresIn: 60 });
		const overwritten = await uploadAsset(worker, { path: "exports/overwritten.zip" });
		const grants = await Promise.all(
			[deleted, expiring, overwritten].map(async (key) => (await issueGrant(worker, { key })).issued.grant),
		);

		await worker.send(`/v1/media/${deleted}`, { method: "DELETE" });
		await uploadAsset(worker, { path: "exports/overwritten.zip", overwrite: true });
		vi.setSystemTime(NOW + 60_000);

		for (const grant of grants) {
			const res = await issueLink(worker, grant);
			expect(res.status).toBe(410);
			expect(await res.json()).toMatchObject({ code: "grant_gone" });
		}
	});

	it("deletes the file only when allowed, behind the lock guard, and takes the file's grants with it", async () => {
		const { worker, results } = recordingWorker();
		const key = await uploadAsset(worker, { path: "exports/delete.zip" });
		const readOnly = (await issueGrant(worker, { key })).issued;
		const deleter = (await issueGrant(worker, { key, canDelete: true })).issued;

		const refused = await worker.send("/v1/grant/file", { method: "DELETE", headers: bearer(readOnly.grant) });
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({ code: "grant_cannot_delete" });

		const removed = await worker.send("/v1/grant/file", { method: "DELETE", headers: bearer(deleter.grant) });
		expect(removed.status).toBe(204);
		expect(worker.mediaBucket.objects.has(`prefix-a/${key}`)).toBe(false);
		expect(results.at(-1)).toMatchObject({
			grantDeletedKey: key,
			revokedGrant: { publicId: deleter.id, by: "bearer" },
		});
		expect((await headFile(worker, readOnly.grant)).status).toBe(410);
	});

	it("emits media.deleted for the file it deleted, like any other delete; a refused delete emits nothing", async () => {
		const events: WebhookEvent[] = [];
		const pluginHooks: PluginHooks = { ...noHooks, onMediaEvent: [(_context, event) => void events.push(event)] };
		const worker = exportsWorker({ pluginHooks });
		const key = await uploadAsset(worker, { path: "exports/emitted.zip" });
		const held = await uploadAsset(worker, { path: "exports/emitted-held.zip", hold: true });
		const readOnly = (await issueGrant(worker, { key })).issued;
		const deleter = (await issueGrant(worker, { key, canDelete: true })).issued;
		const heldDeleter = (await issueGrant(worker, { key: held, canDelete: true })).issued;
		await worker.settle();
		events.length = 0;

		await worker.send("/v1/grant/file", { method: "DELETE", headers: bearer(readOnly.grant) });
		await worker.send("/v1/grant/file", { method: "DELETE", headers: bearer(heldDeleter.grant) });
		await worker.settle();
		expect(events).toEqual([]);

		const removed = await worker.send("/v1/grant/file", { method: "DELETE", headers: bearer(deleter.grant) });
		await worker.settle();
		expect(removed.status).toBe(204);
		expect(events.map(({ type, data }) => ({ type, data }))).toEqual([
			{
				type: "media.deleted",
				data: { key, mediaId: key, kind: "asset", visibility: "private", reason: "api" },
			},
		]);
	});

	it("can't delete a held file", async () => {
		const worker = exportsWorker();
		const key = await uploadAsset(worker, { path: "exports/held.zip", hold: true });
		const { issued } = await issueGrant(worker, { key, canDelete: true });
		const blocked = await worker.send("/v1/grant/file", { method: "DELETE", headers: bearer(issued.grant) });
		expect(blocked.status).toBe(409);
		expect(worker.mediaBucket.objects.has(`prefix-a/${key}`)).toBe(true);
		expect((await headFile(worker, issued.grant)).status).toBe(200);
	});

	it("is identified by its secret, live or not, for a platform to resolve its tenant", async () => {
		const worker = exportsWorker();
		const key = await uploadAsset(worker, { path: "exports/identify.zip" });
		const { issued } = await issueGrant(worker, { key });
		await worker.send(`/v1/token/grant/${issued.id}`, { method: "DELETE" });

		const probe = new Hono<WorkerApp>().get("/", async (context) => {
			const identified = await identifyDownloadGrant(context);
			return identified instanceof Response ? identified : context.json(identified);
		});
		const identify = (grant: string) => probe.request("http://worker/", { headers: bearer(grant) }, worker.env);
		const identified = (await (await identify(issued.grant)).json()) as { grant: Record<string, unknown> };
		expect(identified).toMatchObject({ publicId: issued.id, grant: { key, storagePrefix: "prefix-a/" } });
		expect(identified.grant.revokedAt).toEqual(expect.any(Number));
		expect(identified.grant).not.toHaveProperty("secretHash");
		expect((await identify("dvg_nope")).status).toBe(401);
	});

	it("revokes itself, idempotently", async () => {
		const worker = exportsWorker();
		const key = await uploadAsset(worker, { path: "exports/revoke.zip" });
		const { issued } = await issueGrant(worker, { key });
		expect((await worker.send("/v1/grant", { method: "DELETE", headers: bearer(issued.grant) })).status).toBe(204);
		expect((await worker.send("/v1/grant", { method: "DELETE", headers: bearer(issued.grant) })).status).toBe(204);
		const gone = await headFile(worker, issued.grant);
		expect(gone.status).toBe(410);
	});

	it("asks the authorizeGrant hooks first: a refusal is returned as is and spends nothing", async () => {
		let isBlocked = true;
		const seen: GrantAccessRequest[] = [];
		const pluginHooks: PluginHooks = {
			...noHooks,
			authorizeGrant: [
				(_context, request) => {
					seen.push(request);
					return isBlocked ? Response.json({ code: "grant_revoked" }, { status: 401 }) : null;
				},
			],
		};
		const worker = exportsWorker({ pluginHooks, context: { owner: "a" } });
		const key = await uploadAsset(worker, { path: "exports/gated.zip" });
		const { issued } = await issueGrant(worker, { key, maxLinks: 1 });

		expect((await issueLink(worker, issued.grant)).status).toBe(401);
		expect(seen[0]).toMatchObject({ action: "issue-link", grant: { key, context: { owner: "a" } } });
		expect(seen[0].grant).not.toHaveProperty("secretHash");
		isBlocked = false;
		expect((await issueLink(worker, issued.grant)).status).toBe(200);
	});

	it("isn't a grant on another storage prefix", async () => {
		const worker = exportsWorker();
		const key = await uploadAsset(worker, { path: "exports/tenant.zip" });
		const { issued } = await issueGrant(worker, { key });
		const otherTenant = exportsWorker({ storagePrefix: "prefix-b/" });
		const res = await otherTenant.app.request(
			"http://worker/v1/grant/file",
			{ method: "HEAD", headers: bearer(issued.grant) },
			worker.env,
		);
		expect(res.status).toBe(401);
	});
});

describe("the owner", () => {
	it("lists a file's grants without their secrets, and revokes one by its public id", async () => {
		const { worker, results } = recordingWorker();
		const key = await uploadAsset(worker, { path: "exports/owner.zip" });
		const first = (await issueGrant(worker, { key, metadata: { exportId: "1" } })).issued;
		const second = (await issueGrant(worker, { key })).issued;
		await issueLink(worker, first.grant);

		const listed = (await (await worker.send(`/v1/token/grant?key=${key}`)).json()) as Array<Record<string, unknown>>;
		expect(listed).toHaveLength(2);
		expect(listed.find((grant) => grant.id === first.id)).toMatchObject({
			key,
			linksIssued: 1,
			revokedAt: null,
			metadata: { exportId: "1" },
		});
		expect(JSON.stringify(listed)).not.toContain("secretHash");
		expect(JSON.stringify(listed)).not.toContain(first.grant);

		expect((await worker.send(`/v1/token/grant/${second.id}`, { method: "DELETE" })).status).toBe(204);
		expect(results.at(-1)).toMatchObject({ revokedGrant: { publicId: second.id, by: "owner" } });
		expect((await headFile(worker, second.grant)).status).toBe(410);
		expect((await headFile(worker, first.grant)).status).toBe(200);
		expect((await worker.send("/v1/token/grant/dgr_nope", { method: "DELETE" })).status).toBe(404);
	});

	it("can't revoke another storage prefix's grant", async () => {
		const worker = exportsWorker();
		const key = await uploadAsset(worker, { path: "exports/other.zip" });
		const { issued } = await issueGrant(worker, { key });
		const otherTenant = exportsWorker({ storagePrefix: "prefix-b/" });
		const res = await otherTenant.app.request(
			`http://worker/v1/token/grant/${issued.id}`,
			{ method: "DELETE" },
			worker.env,
		);
		expect(res.status).toBe(404);
		expect((await headFile(worker, issued.grant)).status).toBe(200);
	});
});
