import { afterEach, describe, expect, it, vi } from "vitest";

type Handler = (ctx: { runMutation: (...args: unknown[]) => Promise<void> }, request: Request) => Promise<Response>;

const { routes, componentEnv } = vi.hoisted(() => ({
	routes: [] as { path: string; handler: Handler }[],
	componentEnv: {} as { DEVULTUR_SECRET?: string },
}));

vi.mock("convex/server", () => ({
	httpRouter: () => ({ route: (route: { path: string; handler: Handler }) => routes.push(route) }),
}));
vi.mock("./_generated/server", () => ({ env: componentEnv, httpAction: (handler: Handler) => handler }));
vi.mock("./_generated/api", () => ({ internal: { public: { handleWebhookEvent: "handleWebhookEvent" } } }));

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
