import { createWebhookEvent, signWebhook } from "@devultur/core";
import { afterEach, describe, expect, it, vi } from "vitest";

type Handler = (ctx: { runMutation: (...args: unknown[]) => Promise<void> }, request: Request) => Promise<Response>;

const { routes, componentEnv } = vi.hoisted(() => ({
	routes: [] as { path: string; handler: Handler }[],
	componentEnv: {} as { DEVULTUR_SECRET?: string; DEVULTUR_WEBHOOK_SECRET?: string },
}));

vi.mock("convex/server", () => ({
	httpRouter: () => ({ route: (route: { path: string; handler: Handler }) => routes.push(route) }),
}));
vi.mock("./_generated/server", () => ({ env: componentEnv, httpAction: (handler: Handler) => handler }));
vi.mock("./_generated/api", () => ({
	api: { lifecycle: { applyLifecycleEvent: "applyLifecycleEvent" } },
	internal: { public: { handleWebhookEvent: "handleWebhookEvent" } },
}));

await import("./http");

function webhook(authorization?: string) {
	const handler = routes.find((route) => route.path === "/webhook")?.handler;
	if (!handler) throw new Error("webhook route not registered");
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (authorization !== undefined) headers.Authorization = authorization;
	const runMutation = vi.fn(async () => {});
	const request = new Request("https://app.test/webhook", {
		method: "POST",
		headers,
		body: JSON.stringify({ event: "transcode.started" }),
	});
	return { response: handler({ runMutation }, request), runMutation };
}

afterEach(() => {
	delete componentEnv.DEVULTUR_SECRET;
	delete componentEnv.DEVULTUR_WEBHOOK_SECRET;
});

const SIGNING_SECRET = "whsec_Y29tcG9uZW50LXdlYmhvb2stc2VjcmV0";

async function signed(payload: { id: string }, secret = SIGNING_SECRET) {
	const handler = routes.find((route) => route.path === "/webhook")?.handler;
	if (!handler) throw new Error("webhook route not registered");
	const body = JSON.stringify(payload);
	const headers = await signWebhook({ id: payload.id, payload: body, secret });
	const runMutation = vi.fn(async () => {});
	const request = new Request("https://app.test/webhook", { method: "POST", headers, body });
	return { response: await handler({ runMutation }, request), runMutation };
}

const deletedEvent = createWebhookEvent("media.deleted", {
	key: "public/image/img1/a.jpg",
	mediaId: "img1",
	kind: "image",
	visibility: "public",
	reason: "api",
});

describe("component webhook receiver, signed", () => {
	it("applies a signed lifecycle event", async () => {
		componentEnv.DEVULTUR_SECRET = "sk_secret";
		componentEnv.DEVULTUR_WEBHOOK_SECRET = SIGNING_SECRET;

		const { response, runMutation } = await signed(deletedEvent);

		expect(response.status).toBe(200);
		expect(runMutation).toHaveBeenCalledWith("applyLifecycleEvent", { event: deletedEvent });
	});

	it("accepts either secret during a rotation", async () => {
		componentEnv.DEVULTUR_WEBHOOK_SECRET = `whsec_b2xk ${SIGNING_SECRET}`;

		const { response } = await signed(deletedEvent);

		expect(response.status).toBe(200);
	});

	it("runs a signed transcode event's data through the transcode handler", async () => {
		componentEnv.DEVULTUR_WEBHOOK_SECRET = SIGNING_SECRET;
		const data = { event: "transcode.started" as const, videoId: "v1", totalSegments: 1, duration: 2 };

		const { response, runMutation } = await signed(createWebhookEvent("transcode.started", data));

		expect(response.status).toBe(200);
		expect(runMutation).toHaveBeenCalledWith("handleWebhookEvent", data);
	});

	it("rejects a signature made with another secret", async () => {
		componentEnv.DEVULTUR_WEBHOOK_SECRET = SIGNING_SECRET;

		const { response, runMutation } = await signed(deletedEvent, "another-secret");

		expect(response.status).toBe(401);
		expect(runMutation).not.toHaveBeenCalled();
	});

	it("rejects a signed event when DEVULTUR_WEBHOOK_SECRET is unset", async () => {
		componentEnv.DEVULTUR_SECRET = "sk_secret";

		const { response, runMutation } = await signed(deletedEvent);

		expect(response.status).toBe(401);
		expect(runMutation).not.toHaveBeenCalled();
	});
});

describe("component webhook receiver", () => {
	it("runs the event for the configured bearer", async () => {
		componentEnv.DEVULTUR_SECRET = "sk_secret";
		const { response, runMutation } = webhook("Bearer sk_secret");
		expect((await response).status).toBe(200);
		expect(runMutation).toHaveBeenCalledOnce();
	});

	it("rejects a wrong bearer", async () => {
		componentEnv.DEVULTUR_SECRET = "sk_secret";
		const { response, runMutation } = webhook("Bearer sk_other");
		expect((await response).status).toBe(401);
		expect(runMutation).not.toHaveBeenCalled();
	});

	it.each([
		["unset", undefined, "Bearer undefined"],
		["empty", "", "Bearer "],
	])("fails closed when DEVULTUR_SECRET is %s", async (_label, secret, authorization) => {
		if (secret !== undefined) componentEnv.DEVULTUR_SECRET = secret;
		const { response, runMutation } = webhook(authorization);
		expect((await response).status).toBe(401);
		expect(runMutation).not.toHaveBeenCalled();
	});
});
