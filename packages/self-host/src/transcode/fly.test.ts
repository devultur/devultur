import { afterEach, describe, expect, it, vi } from "vitest";
import { createFlyMachine, createFlyRunner, DEFAULT_FLY_GUEST, type FlyMachineRequest, flyGuestFromEnv } from "./fly";

const request: FlyMachineRequest = {
	appName: "example-transcode",
	apiToken: "fly-token",
	image: "registry.fly.io/example-transcode:tag",
	guest: DEFAULT_FLY_GUEST,
	env: { VIDEO_ID: "vid1" },
	script: "echo hi",
};
const noWait = { sleep: async () => {} };

function stubFly(handler: (url: string, init?: RequestInit) => Response) {
	const calls: Array<{ url: string; method: string; body?: string }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
			return handler(url, init);
		}),
	);
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("flyGuestFromEnv", () => {
	it("defaults to performance-4x (4 vCPU, 8 GB)", () => {
		expect(flyGuestFromEnv({})).toEqual({ cpu_kind: "performance", cpus: 4, memory_mb: 8192 });
	});

	it("lets each field be overridden by env, ignoring invalid numbers", () => {
		expect(
			flyGuestFromEnv({ FLY_TRANSCODE_CPU_KIND: "shared", FLY_TRANSCODE_CPUS: "2", FLY_TRANSCODE_MEMORY_MB: "2048" }),
		).toEqual({ cpu_kind: "shared", cpus: 2, memory_mb: 2048 });
		expect(flyGuestFromEnv({ FLY_TRANSCODE_CPUS: "lots", FLY_TRANSCODE_MEMORY_MB: "-1" })).toEqual(DEFAULT_FLY_GUEST);
	});
});

describe("createFlyMachine", () => {
	it("sends the guest, env and the script as init.cmd", async () => {
		const calls = stubFly(() => Response.json({ id: "m1", state: "created" }));
		const result = await createFlyMachine(request, noWait);
		expect(result).toEqual({ ok: true, machine: { id: "m1", state: "created" } });
		const payload = JSON.parse(calls[0]?.body ?? "{}");
		expect(payload.config.guest).toEqual(DEFAULT_FLY_GUEST);
		expect(payload.config.env).toEqual({ VIDEO_ID: "vid1" });
		expect(payload.config.init.cmd[0]).toBe(`echo '${btoa("echo hi")}' | base64 -d | sh`);
		expect(payload.config.auto_destroy).toBe(true);
		expect(payload).not.toHaveProperty("region");
	});

	it("sends the region only when one is given", async () => {
		const calls = stubFly(() => Response.json({ id: "m1", state: "created" }));
		await createFlyMachine({ ...request, region: "gru" }, noWait);
		expect(JSON.parse(calls[0]?.body ?? "{}").region).toBe("gru");
	});

	it("retries 429 from the Machines API and succeeds", async () => {
		let attempt = 0;
		const calls = stubFly(() => {
			attempt++;
			return attempt < 3
				? new Response("rate limited", { status: 429 })
				: Response.json({ id: "m2", state: "created" });
		});
		const result = await createFlyMachine(request, noWait);
		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(3);
	});

	it("fails loud with 503 after exhausting retries", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const calls = stubFly(() => new Response("rate limited", { status: 429 }));
		const result = await createFlyMachine(request, noWait);
		expect(result).toEqual({
			ok: false,
			status: 503,
			error: "Failed to create transcode job",
			code: "transcode_runner_unavailable",
			detail: "rate limited",
		});
		expect(calls).toHaveLength(5);
		expect(errorSpy).toHaveBeenCalled();
	});

	it("does not retry a 4xx config error", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const calls = stubFly(() => new Response("bad guest", { status: 422 }));
		const result = await createFlyMachine(request, noWait);
		expect(result).toMatchObject({ ok: false, status: 500, code: "transcode_launch_failed", detail: "bad guest" });
		expect(calls).toHaveLength(1);
	});

	it("resumes a suspended app and creates the machine", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		let created = false;
		const calls = stubFly((url, init) => {
			if (url.endsWith("/machines") && !created) {
				created = true;
				return new Response("app is suspended", { status: 412 });
			}
			if (url.endsWith("/machines")) return Response.json({ id: "m3", state: "created" });
			if (init?.method === "PUT") return Response.json({});
			return Response.json({ status: "suspended" });
		});
		const pending = createFlyMachine(request, noWait);
		await vi.runAllTimersAsync();
		const result = await pending;
		expect(result.ok).toBe(true);
		expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "PUT", "POST"]);
	});
});

describe("createFlyRunner", () => {
	const flyEnv = {
		FLY_APP_NAME: "example-transcode",
		FLY_API_TOKEN: "fly-token",
		FLY_TRANSCODE_IMAGE: "registry.fly.io/example-transcode:tag",
	};
	const job = { videoId: "vid1", script: "echo hi", env: { VIDEO_ID: "vid1" } };

	it("sends FLY_REGION as the machine region", async () => {
		const calls = stubFly(() => Response.json({ id: "m1", state: "created" }));
		await createFlyRunner({ ...flyEnv, FLY_REGION: "iad" }, noWait).launch(job);
		expect(JSON.parse(calls[0]?.body ?? "{}").region).toBe("iad");
	});

	it("omits the region without FLY_REGION so Fly picks one", async () => {
		const calls = stubFly(() => Response.json({ id: "m1", state: "created" }));
		await createFlyRunner({ ...flyEnv, FLY_REGION: " " }, noWait).launch(job);
		expect(JSON.parse(calls[0]?.body ?? "{}")).not.toHaveProperty("region");
	});
});
