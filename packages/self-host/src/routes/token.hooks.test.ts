import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createWorker, defaultPlugins, type WorkerPlugin } from "../index";
import type { CredentialDecision, CredentialRequest } from "../plugin-hooks";
import { WORKER_SECRETS, withWorkerAuth } from "../plugins/worker-secret-auth-test-env";
import { updateRequestState } from "../request-state";
import type { WorkerApp } from "../types";

const env = { DELIVERY_SIGN_SECRET: "delivery-secret", ...WORKER_SECRETS };

/** A Worker with the default plugins plus `extra`. */
const workerWith = (...extra: WorkerPlugin[]) => createWorker({ plugins: [...defaultPlugins(), ...extra] });

function issueToken(body: Record<string, unknown>, plugin?: WorkerPlugin, path = "/v1/token") {
	const worker = workerWith(...(plugin ? [plugin] : []));
	return worker.request(
		path,
		withWorkerAuth({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
		env as never,
	);
}

function claimsOf(token: string) {
	return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
}

/** Plugin that records what it was asked and answers `decision`. */
function recordingHook(decision: CredentialDecision) {
	const requests: CredentialRequest[] = [];
	const hooks: WorkerPlugin = {
		name: "recording",
		issueCredential: (_context, request) => {
			requests.push(request);
			return decision;
		},
	};
	return { hooks, requests };
}

describe("POST /v1/token and the issueCredential hook", () => {
	it("without a hook issues what the request asks for, with only the Worker's claims", async () => {
		const res = await issueToken({ userId: "u1", scopes: ["media:read", "custom"], expiresIn: 60 });
		const { token, expiresIn } = (await res.json()) as { token: string; expiresIn: number };
		const claims = claimsOf(token);
		expect(claims.scope).toBe("media:read custom");
		expect(expiresIn).toBe(60);
		expect(Object.keys(claims).sort()).toEqual(["bind", "exp", "fp", "fpip", "iat", "ip", "nonce", "scope", "sub"]);
	});

	it("asks the hook with the kind, the scopes and the requested expiry", async () => {
		const { hooks, requests } = recordingHook({ allow: true });
		const before = Date.now();
		await issueToken({ userId: "u1", scopes: ["media:read"], expiresIn: 600 }, hooks);
		expect(requests).toEqual([{ kind: "viewer", scopes: ["media:read"], expiresAt: expect.any(Number) }]);
		expect(requests[0].expiresAt).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 + 600_000);
	});

	it("returns the hook's refusal as is", async () => {
		const { hooks } = recordingHook({ allow: false, response: Response.json({ code: "nope" }, { status: 403 }) });
		const res = await issueToken({ userId: "u1" }, hooks);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ code: "nope" });
	});

	it("caps the expiry at the hook's and adds its claims, never over the Worker's own", async () => {
		const { hooks } = recordingHook({
			allow: true,
			expiresAt: Date.now() + 30_000,
			claims: { tag: "a", sub: "spoofed", scope: "*" },
		});
		const res = await issueToken({ userId: "u1", expiresIn: 7200 }, hooks);
		const { token, expiresIn } = (await res.json()) as { token: string; expiresIn: number };
		expect(claimsOf(token)).toMatchObject({ tag: "a", sub: "u1", scope: "media:read" });
		expect(expiresIn).toBeLessThanOrEqual(30);
	});

	it.each(["pid", "ppx", "scopes"])("refuses to issue a token when a hook adds the reserved claim %s", async (name) => {
		const { hooks } = recordingHook({ allow: true, claims: { [name]: "x" } });
		const res = await issueToken({ userId: "u1" }, hooks);
		expect(res.status).toBe(500);
		expect(await res.json()).not.toHaveProperty("token");
	});

	it("logs an error that names the reserved claim", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const { hooks } = recordingHook({ allow: true, claims: { scopes: ["media:read"] } });
		await issueToken({ userId: "u1" }, hooks);
		expect(String(logged.mock.calls[0]?.[1])).toMatch(/claim `scopes`, which is reserved/);
		logged.mockRestore();
	});

	it("asks the hook before an upload token, with its prefix", async () => {
		const { hooks, requests } = recordingHook({ allow: true, claims: { tag: "b" } });
		const res = await issueToken({ prefix: "exports/" }, hooks, "/v1/token/upload");
		const { token } = (await res.json()) as { token: string };
		expect(requests[0]).toMatchObject({ kind: "upload", scopes: ["media:write"], path: "asset/exports/" });
		expect(claimsOf(token)).toMatchObject({ typ: "upload", res: "asset/exports/", tag: "b" });
	});
});

describe("POST /v1/token storage prefix claim", () => {
	function issueUnderPrefix(storagePrefix: string, hooks?: WorkerPlugin) {
		const prefixed: WorkerPlugin = {
			name: "prefixed",
			middleware: {
				afterAuth: [
					async (context, next) => {
						updateRequestState(context, { storagePrefix });
						await next();
					},
				],
			},
		};
		const worker = workerWith(prefixed, ...(hooks ? [hooks] : []));
		return worker.request(
			"/v1/token",
			withWorkerAuth({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ userId: "u1" }),
			}),
			env as never,
		);
	}

	async function claimsUnderPrefix(storagePrefix: string, hooks?: WorkerPlugin) {
		const { token } = (await (await issueUnderPrefix(storagePrefix, hooks)).json()) as { token: string };
		return claimsOf(token);
	}

	it("binds the token to the request's storage prefix, without its trailing slash", async () => {
		expect((await claimsUnderPrefix("acme/")).aud).toBe("acme");
	});

	it("never lets a hook claim another prefix", async () => {
		const { hooks } = recordingHook({ allow: true, claims: { aud: "other" } });
		expect((await claimsUnderPrefix("acme/", hooks)).aud).toBe("acme");
	});

	it("adds no `aud` at the bucket root", async () => {
		expect((await claimsUnderPrefix("")).aud).toBeUndefined();
	});
});

describe("POST /v1/token scopes", () => {
	it.each([[["media:read media:write"]], [[""]], [[1]], ["media:read"]])("rejects %j with 400", async (scopes) => {
		const res = await issueToken({ userId: "u1", scopes });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "invalid_scopes" });
	});
});

describe("POST /v1/token reserved subject", () => {
	it("rejects a userId with the service prefix", async () => {
		const res = await issueToken({ userId: "transcode:vid1" });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "reserved_user_id" });
	});

	it("never stamps the service `typ` on a viewer token", async () => {
		const res = await issueToken({ userId: "u1", typ: "transcode" });
		const { token } = (await res.json()) as { token: string };
		expect(claimsOf(token).typ).toBeUndefined();
	});
});

describe("plugin routes", () => {
	it("a plain Worker has no /v1/extra", async () => {
		const res = await createWorker().request("/v1/extra", withWorkerAuth({ method: "POST" }), env as never);
		expect(res.status).toBe(404);
	});

	it("mounts a plugin's routes behind the plugins' middleware", async () => {
		const extra = new Hono<WorkerApp>().get("/", (context) => context.json({ ok: true }));
		const worker = workerWith({ name: "extra", routes: [{ path: "/v1/extra", app: extra }] });
		expect(await (await worker.request("/v1/extra", withWorkerAuth(), env as never)).json()).toEqual({ ok: true });
	});
});
