import { createWebhookEvent, signWebhook } from "@devultur/core";
import type { HttpRouter } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentApi } from "../src/component/_generated/component.js";

// `registerDevulturWebhook`: the app's route verifies the signature, runs the component's mutation, then the app's.
vi.mock("convex/server", () => ({ httpActionGeneric: (handler: unknown) => handler }));

const { registerDevulturWebhook } = await import("../src/webhook-route");

const SECRET = "whsec_YXBwLXdlYmhvb2stc2VjcmV0LWZvci10ZXN0cw==";

type Handler = (ctx: unknown, request: Request) => Promise<Response>;

const component = {
	lifecycle: { applyLifecycleEvent: "component.applyLifecycleEvent", forgetLifecycleEvent: "component.forget" },
} as unknown as ComponentApi;

const deleted = createWebhookEvent("media.deleted", {
	key: "public/image/img1/a.jpg",
	mediaId: "img1",
	kind: "image",
	visibility: "public",
	reason: "api",
});
const changed = createWebhookEvent("media.changed", {
	key: "public/image/img1/a.jpg",
	mediaId: "img1",
	changes: ["replaced"],
	etag: "e2",
});

function setup(options: { signingSecret?: string; failingHandler?: boolean } = {}) {
	const routes: { path: string; method: string; handler: Handler }[] = [];
	const http = { route: (route: (typeof routes)[number]) => routes.push(route) } as unknown as HttpRouter;
	registerDevulturWebhook(http, component, {
		path: "/media-webhooks",
		signingSecret: options.signingSecret ?? SECRET,
		onMediaDeleted: "app.onMediaDeleted" as never,
		onMediaChanged: "app.onMediaChanged" as never,
	});
	const processed = new Set<string>();
	const runMutation = vi.fn(async (reference: string, args: Record<string, unknown>) => {
		if (reference === "component.applyLifecycleEvent") {
			const { id } = args.event as { id: string };
			const isDuplicate = processed.has(id);
			processed.add(id);
			return { isDuplicate, isApplied: !isDuplicate };
		}
		if (reference === "component.forget") processed.delete(args.eventId as string);
		if (reference.startsWith("app.") && options.failingHandler) throw new Error("app handler failed");
		return null;
	});
	const post = async (payload: { id: string }, secret = SECRET) => {
		const body = JSON.stringify(payload);
		const headers = await signWebhook({ id: payload.id, payload: body, secret });
		const request = new Request("https://app.test/media-webhooks", { method: "POST", headers, body });
		return routes[0].handler({ runMutation }, request);
	};
	return { routes, runMutation, post, processed };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("registerDevulturWebhook", () => {
	it("registers a POST route at the path", () => {
		const { routes } = setup();

		expect(routes.map(({ path, method }) => ({ path, method }))).toEqual([{ path: "/media-webhooks", method: "POST" }]);
	});

	it("runs the component's mutation, then the app's handler for the event's type", async () => {
		const { runMutation, post } = setup();

		expect((await post(deleted)).status).toBe(200);
		expect((await post(changed)).status).toBe(200);

		expect(runMutation.mock.calls.map(([reference]) => reference)).toEqual([
			"component.applyLifecycleEvent",
			"app.onMediaDeleted",
			"component.applyLifecycleEvent",
			"app.onMediaChanged",
		]);
		expect(runMutation).toHaveBeenCalledWith("app.onMediaDeleted", { event: deleted });
	});

	it("runs the app's handler once for a redelivered event", async () => {
		const { runMutation, post } = setup();

		await post(deleted);
		const redelivery = await post(deleted);

		expect(redelivery.status).toBe(200);
		expect(runMutation.mock.calls.filter(([reference]) => reference === "app.onMediaDeleted")).toHaveLength(1);
	});

	it("answers 500 and forgets the event when the app's handler fails, so a retry runs it again", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { post, processed } = setup({ failingHandler: true });

		const response = await post(deleted);

		expect(response.status).toBe(500);
		expect(processed.has(deleted.id)).toBe(false);
	});

	it("refuses an unsigned or wrongly signed request", async () => {
		const { runMutation, post, routes } = setup();

		const wrong = await post(deleted, "another-secret");
		const unsigned = await routes[0].handler(
			{ runMutation },
			new Request("https://app.test/media-webhooks", { method: "POST", body: JSON.stringify(deleted) }),
		);

		expect([wrong.status, unsigned.status]).toEqual([401, 401]);
		expect(runMutation).not.toHaveBeenCalled();
	});

	it("reads DEVULTUR_WEBHOOK_SECRET when no secret is passed, and fails closed without one", async () => {
		const routes: { handler: Handler }[] = [];
		const http = { route: (route: { handler: Handler }) => routes.push(route) } as unknown as HttpRouter;
		registerDevulturWebhook(http, component, { path: "/media-webhooks" });
		const body = JSON.stringify(deleted);
		const request = async () =>
			new Request("https://app.test/media-webhooks", {
				method: "POST",
				headers: await signWebhook({ id: deleted.id, payload: body, secret: SECRET }),
				body,
			});
		const runMutation = vi.fn(async () => ({ isDuplicate: false, isApplied: true }));

		const withoutSecret = await routes[0].handler({ runMutation }, await request());
		vi.stubEnv("DEVULTUR_WEBHOOK_SECRET", SECRET);
		const withSecret = await routes[0].handler({ runMutation }, await request());

		expect([withoutSecret.status, withSecret.status]).toEqual([401, 200]);
	});

	it("acknowledges other event types without running anything", async () => {
		const { runMutation, post } = setup();
		const transcode = createWebhookEvent("transcode.complete", {
			event: "transcode.complete",
			videoId: "v1",
			duration: 1,
			playlistKey: "p.m3u8",
			thumbnailKey: "t.jpg",
		});

		expect((await post(transcode)).status).toBe(204);
		expect(runMutation).not.toHaveBeenCalled();
	});
});
