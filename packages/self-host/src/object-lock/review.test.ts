// Regression tests from the security review of the object lock: each one fails on the code before its fix.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportsWorker } from "../exports-test-harness";
import { createWorker } from "../index";
import { defaultPlugins } from "../plugins";
import { withWorkerAuth } from "../plugins/worker-secret-auth-test-env";
import { signJobTicket } from "../transcode/job-ticket";
import { loggedAudits } from "./audit-test-support";
import { lockedFixture, RAW_KEY } from "./worker-fixture";

const COMPLIANCE_DEFAULT = { lock: { retention: { mode: "compliance" as const, until: "2999-01-01T00:00:00Z" } } };
const empty = () => ({ bytes: new Uint8Array(1), httpMetadata: {}, customMetadata: {} });

afterEach(() => vi.restoreAllMocks());

function quiet() {
	return vi.spyOn(console, "log").mockImplementation(() => {});
}

async function uploadPdf(
	send: (path: string, init?: RequestInit) => Response | Promise<Response>,
	body: Record<string, unknown>,
) {
	const created = await send("/v1/upload", {
		method: "POST",
		body: JSON.stringify({ filename: "a.pdf", contentType: "application/pdf", ...body }),
	});
	const { key, uploadUrl } = (await created.json()) as { key: string; uploadUrl: string };
	const put = await send(uploadUrl, {
		method: "PUT",
		body: "same bytes",
		headers: { "Content-Type": "application/pdf" },
	});
	expect(put.status).toBe(200);
	return key;
}

describe("1. deleting an asset keeps the keys of an asset nested under its path", () => {
	it("only the object's own key and its variants' keys go", async () => {
		const worker = exportsWorker({ security: { encrypt: true } });
		const upload = async (path: string) => {
			const created = await worker.postJson("/v1/upload", { contentType: "application/zip", path });
			const { key, uploadUrl } = (await created.json()) as { key: string; uploadUrl: string };
			await worker.send(uploadUrl, { method: "PUT", body: "zip", headers: { "Content-Type": "application/zip" } });
			return key;
		};
		const parent = await upload("exports/a");
		const child = await upload("exports/a/b.pdf");
		const keysUnder = (key: string) =>
			[...worker.keysBucket.objects.keys()].filter((k) => k.startsWith(`prefix-a/${key}/`));
		const childKeys = keysUnder(child);
		expect(childKeys).toHaveLength(1);

		expect((await worker.send(`/v1/media/${parent}`, { method: "DELETE" })).status).toBe(204);

		expect(keysUnder(child)).toEqual(childKeys);
		expect(keysUnder(parent).filter((k) => !childKeys.includes(k))).toEqual([]);
	});
});

describe("2. a stale lock record never applies to a new upload of the same bytes", () => {
	it("released hold, delete, re-upload of identical bytes under a compliance default: still locked", async () => {
		quiet();
		const fixture = lockedFixture();
		const path = "docs/same.pdf";
		const key = await uploadPdf(fixture.send, { path, hold: true });
		await fixture.send("/v1/lock/hold", { method: "POST", body: JSON.stringify({ hold: false, keys: [key] }) });
		expect((await fixture.send(`/v1/media/${key}`, { method: "DELETE" })).status).toBe(204);
		expect(fixture.mediaBucket.objects.has(`__lock/${key}`)).toBe(false);

		// The same Worker, now with a compliance default: the new object's own lock must hold.
		const strict = createWorker({ plugins: defaultPlugins(COMPLIANCE_DEFAULT) });
		const send = (target: string, init?: RequestInit) =>
			strict.request(
				`https://media.example${target}`,
				withWorkerAuth(init),
				fixture.env as never,
				fixture.executionCtx as never,
			);
		expect(await uploadPdf(send, { path })).toBe(key);
		expect(await (await send(`/v1/lock/${key}`)).json()).toMatchObject({ mode: "compliance", source: "upload" });
		expect((await send(`/v1/media/${key}`, { method: "DELETE" })).status).toBe(409);
	});

	it("an overwrite drops the replaced object's lock record", async () => {
		quiet();
		const { send, mediaBucket } = lockedFixture();
		const key = await uploadPdf(send, { path: "docs/over.pdf", hold: true });
		await send("/v1/lock/hold", { method: "POST", body: JSON.stringify({ hold: false, keys: [key] }) });
		expect(mediaBucket.objects.has(`__lock/${key}`)).toBe(true);
		await uploadPdf(send, { path: "docs/over.pdf", overwrite: true });
		expect(mediaBucket.objects.has(`__lock/${key}`)).toBe(false);
	});
});

describe("3. a held period can't be swapped for a date while the hold stays", () => {
	it("PUT /v1/lock refuses it on compliance", async () => {
		quiet();
		const { send, mediaBucket } = lockedFixture();
		const key = "private/file/p/p.pdf";
		const lock = JSON.stringify({ retention: { mode: "compliance", period: 3600 }, hold: true });
		mediaBucket.objects.set(key, { ...empty(), customMetadata: { lock } });
		const res = await send(`/v1/lock/${key}`, {
			method: "PUT",
			body: JSON.stringify({ until: "2999-01-01T00:00:00Z" }),
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "compliance_extend_only" });
	});
});

describe("4. a bulk hold by prefix never touches the Worker's own records", () => {
	it("skips __lock and __lock-audit objects", async () => {
		quiet();
		const { send, mediaBucket } = lockedFixture();
		mediaBucket.objects.set("__lock-audit/2030-01-01/1-x.json", empty());
		mediaBucket.objects.set("__lock/private/file/a/a.pdf", empty());
		for (const prefix of ["_", "__loc"]) {
			const res = await send("/v1/lock/hold", { method: "POST", body: JSON.stringify({ hold: true, prefix }) });
			expect(await res.json()).toEqual({ updated: [], skipped: [] });
		}
		expect([...mediaBucket.objects.keys()].filter((key) => key.startsWith("__lock/__lock"))).toEqual([]);
	});
});

describe("5. the transcode completion marker doesn't need the 24 h launch record", () => {
	it("is written from the job ticket's location", async () => {
		quiet();
		const { app, env, executionCtx, mediaBucket } = lockedFixture();
		const { ticket } = await signJobTicket(env.DELIVERY_SIGN_SECRET, {
			videoId: "vid1",
			location: { root: "", folder: "private/video/vid1" },
		});
		const res = await app.request(
			"https://media.example/v1/webhooks/transcode",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${env.TRANSCODE_WEBHOOK_SECRET}`, "X-Devultur-Job": ticket },
				body: JSON.stringify({ event: "transcode.complete", videoId: "vid1", duration: 1 }),
			},
			env as never,
			executionCtx as never,
		);
		expect(res.status).toBe(200);
		expect(mediaBucket.objects.has("__lock/private/video/vid1/transcode-completed")).toBe(true);
	});
});

describe("6. an unreadable hold release time fails closed", () => {
	it("reads the object as held", async () => {
		quiet();
		const { send, mediaBucket } = lockedFixture();
		const key = "private/file/r/r.pdf";
		mediaBucket.objects.set(key, empty());
		// Bound to this exact object either way: by version, and by the content etag an older binding used.
		const objectEtag = createHash("md5").update(new Uint8Array(1)).digest("hex");
		const lock = { retention: { mode: "compliance", period: 60 }, hold: false };
		const sidecar = { revision: 1, objectVersion: "v0", objectEtag, lock };
		mediaBucket.objects.set(`__lock/${key}`, {
			...empty(),
			bytes: new TextEncoder().encode(JSON.stringify({ ...sidecar, holdReleasedAt: "not a date", updatedAt: "" })),
		});
		expect((await send(`/v1/media/${key}`, { method: "DELETE" })).status).toBe(409);
	});
});

describe("7. a retention period beyond what a date can hold is refused, never a 500", () => {
	it("answers 400 invalid_lock", async () => {
		const { send } = lockedFixture();
		const res = await send("/v1/upload", {
			method: "POST",
			body: JSON.stringify({
				filename: "a.pdf",
				contentType: "application/pdf",
				expiresIn: 60,
				lock: { retention: { mode: "compliance", period: Number.MAX_SAFE_INTEGER } },
			}),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "invalid_lock" });
	});
});

describe("8. a hold refused by authorizeLockChange is audited", () => {
	it("records the refusal", async () => {
		const log = quiet();
		const refuse = {
			name: "refuse",
			authorizeLockChange: () => ({ allow: false as const, response: Response.json({ code: "no" }, { status: 403 }) }),
		};
		const { send } = lockedFixture({ plugins: [refuse] });
		const res = await send("/v1/lock/hold", { method: "POST", body: JSON.stringify({ hold: false, keys: [RAW_KEY] }) });
		expect(res.status).toBe(403);
		expect(loggedAudits(log)).toEqual([
			expect.objectContaining({ action: "release", keys: [RAW_KEY], outcome: "rejected", reason: "hook_refused" }),
		]);
	});
});

describe("9. an authenticated PUT with no pending upload gets the config's default lock", () => {
	it("locks an original, not a video's derived output", async () => {
		quiet();
		const { send, mediaBucket } = lockedFixture({ config: COMPLIANCE_DEFAULT });
		const put = (key: string) =>
			send(`/v1/upload/${key}`, { method: "PUT", body: "x", headers: { "Content-Type": "text/plain" } });
		expect((await put("private/file/d/direct.txt")).status).toBe(200);
		expect(mediaBucket.objects.get("private/file/d/direct.txt")?.customMetadata.lock).toBeDefined();
		expect((await send("/v1/media/private/file/d/direct.txt", { method: "DELETE" })).status).toBe(409);

		expect((await put("private/video/vid2/hls/seg-0.ts")).status).toBe(200);
		expect(mediaBucket.objects.get("private/video/vid2/hls/seg-0.ts")?.customMetadata.lock).toBeUndefined();
	});
});

describe("10. a locked file doesn't expire", () => {
	it("is served past its expiresAt while held, and 410 once free", async () => {
		quiet();
		const { send, mediaBucket } = lockedFixture();
		const key = "private/file/e/e.pdf";
		const expiresAt = String(Date.now() - 1000);
		mediaBucket.objects.set(key, { ...empty(), customMetadata: { expiresAt, lock: JSON.stringify({ hold: true }) } });
		expect((await send(`/v1/media/${key}`)).status).toBe(200);
		await send("/v1/lock/hold", { method: "POST", body: JSON.stringify({ hold: false, keys: [key] }) });
		expect((await send(`/v1/media/${key}`)).status).toBe(410);
	});
});
