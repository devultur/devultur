import type { MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { verifyViewerToken } from "../helpers";
import { WORKER_SECRETS, withWorkerAuth, workerWithMiddleware } from "../plugins/worker-secret-auth-test-env";
import { updateRequestState } from "../request-state";
import { getRouteResult, type RouteResult } from "../route-result";
import type { TranscodeContainerNamespace } from "./cloudflare";
import { JOB_TICKET_HEADER, signJobTicket, verifyJobTicket } from "./job-ticket";
import { buildScript } from "./script";

const SECRET = "delivery";
const RAW_KEY = "public/video/vid1/raw/clip.mp4";

describe("job ticket", () => {
	it("round-trips the video, a run id per launch, the launch time and the plugin context", async () => {
		const launchSecondMs = Math.floor(Date.now() / 1000) * 1000;
		const nowMs = launchSecondMs + 500;
		const { ticket, runId } = await signJobTicket(SECRET, { videoId: "vid1", context: { owner: "a" } }, nowMs);
		expect(await verifyJobTicket(SECRET, ticket, "vid1")).toEqual({
			runId,
			videoId: "vid1",
			startedAt: launchSecondMs,
			context: { owner: "a" },
		});
		const again = await signJobTicket(SECRET, { videoId: "vid1" }, nowMs);
		expect(again.runId).not.toBe(runId);
	});

	it("rejects a missing, altered, foreign-key or other-video ticket", async () => {
		const { ticket } = await signJobTicket(SECRET, { videoId: "vid1", context: { owner: "a" } });
		const [header, , signature] = ticket.split(".");
		const forgedPayload = btoa(
			JSON.stringify({ typ: "transcode-job", sub: "vid1", jti: "x", iat: 1, context: { owner: "b" } }),
		)
			.replace(/=+$/, "")
			.replace(/\+/g, "-")
			.replace(/\//g, "_");
		expect(await verifyJobTicket(SECRET, undefined, "vid1")).toBeNull();
		expect(await verifyJobTicket(SECRET, `${header}.${forgedPayload}.${signature}`, "vid1")).toBeNull();
		expect(await verifyJobTicket("other-secret", ticket, "vid1")).toBeNull();
		expect(await verifyJobTicket(SECRET, ticket, "vid2")).toBeNull();
	});

	it("is never a valid viewer token under the delivery secret", async () => {
		const { ticket } = await signJobTicket(SECRET, { videoId: "vid1" });
		expect(await verifyViewerToken(ticket, SECRET)).toBeNull();
	});

	it("rejects an expired ticket", async () => {
		const { ticket } = await signJobTicket(SECRET, { videoId: "vid1" }, Date.now() - 3 * 24 * 60 * 60 * 1000);
		expect(await verifyJobTicket(SECRET, ticket, "vid1")).toBeNull();
	});

	it("is sent by the script on every callback", () => {
		const script = buildScript({
			videoId: "vid1",
			maxResolution: "720p" as never,
			outputPrefix: "public/video/vid1/hls/",
			thumbnailKey: "public/video/vid1/thumbnails/thumbnail.jpg",
		});
		const callbacks = script.split("\n").filter((line) => line.includes('"$CALLBACK_URL"'));
		expect(callbacks.length).toBeGreaterThan(0);
		for (const line of callbacks) expect(line).toContain(`-H "${JOB_TICKET_HEADER}: $JOB_TICKET"`);
	});
});

describe("job ticket through the Worker", () => {
	function setup() {
		const launches: Array<{ env: Record<string, string> }> = [];
		const facts: RouteResult[] = [];
		const namespace: TranscodeContainerNamespace = {
			idFromName: (name) => name as unknown as DurableObjectId,
			get: () => ({
				launch: async (request) => {
					launches.push(request);
					return { alreadyRunning: false };
				},
				cancel: async () => {},
			}),
		};
		const kv = new Map<string, string>();
		const env = {
			...WORKER_SECRETS,
			TRANSCODE_RUNNER: "cloudflare",
			TRANSCODE_CONTAINER: namespace,
			DELIVERY_SIGN_SECRET: SECRET,
			MEDIA_BUCKET: {
				head: async () => ({ size: 10, customMetadata: {} }),
				get: async () => null,
				put: async () => ({}),
			},
			MEDIA_KV: {
				get: async (key: string, type?: string) => {
					const value = kv.get(key) ?? null;
					return type === "json" && value ? JSON.parse(value) : value;
				},
				put: async (key: string, value: string) => void kv.set(key, value),
				delete: async (key: string) => void kv.delete(key),
			},
		};
		const stampAndCapture: MiddlewareHandler = async (context, next) => {
			updateRequestState(context, { context: { owner: "acme" } });
			await next();
			facts.push(getRouteResult(context));
		};
		const app = workerWithMiddleware(stampAndCapture);
		const send = (path: string, init?: RequestInit) =>
			app.request(`https://media.example${path}`, withWorkerAuth(init), env as never, { waitUntil() {} } as never);
		return { send, launches, facts };
	}

	it("hands the runner a ticket with the plugin context, and publishes the job of a completion that echoes it", async () => {
		const { send, launches, facts } = setup();
		await send("/v1/transcode", { method: "POST", body: JSON.stringify({ key: RAW_KEY }) });
		const ticket = launches[0]?.env.JOB_TICKET;
		expect(ticket).toBeTruthy();

		const complete = JSON.stringify({ event: "transcode.complete", videoId: "vid1", duration: 10 });
		const res = await send("/v1/webhooks/transcode", {
			method: "POST",
			body: complete,
			headers: { [JOB_TICKET_HEADER]: ticket as string },
		});
		expect(res.status).toBe(200);
		expect(facts.at(-1)?.transcodeJob).toMatchObject({ videoId: "vid1", context: { owner: "acme" } });
	});

	it("publishes no job for a callback without a ticket (a runner launched before it existed)", async () => {
		const { send, facts } = setup();
		const complete = JSON.stringify({ event: "transcode.complete", videoId: "vid1", duration: 10 });
		await send("/v1/webhooks/transcode", { method: "POST", body: complete });
		expect(facts.at(-1)?.transcodeJob).toBeUndefined();
	});
});
