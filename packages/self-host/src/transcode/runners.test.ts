import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerEnv } from "../types";
import {
	type ContainerHandle,
	createCloudflareContainerRunner,
	isUnreportedCrash,
	startTranscodeContainer,
	type TranscodeContainerNamespace,
	watchContainer,
} from "./cloudflare";
import { createHttpRunner, type HttpRunnerJobRequest } from "./http";
import { parseRunnerName, RUN_SCRIPT_COMMAND, SCRIPT_ENV_VAR, type TranscodeJob } from "./runner";
import { createRunner } from "./runners";

const job: TranscodeJob = {
	videoId: "vid1",
	script: "echo hi",
	env: { VIDEO_ID: "vid1", CALLBACK_URL: "https://w/cb" },
};
const noWait = { sleep: async () => {} };

afterEach(() => vi.unstubAllGlobals());

describe("runner selection", () => {
	it("defaults to cloudflare and is case-insensitive", () => {
		expect(parseRunnerName(undefined)).toBe("cloudflare");
		expect(parseRunnerName("  ")).toBe("cloudflare");
		expect(parseRunnerName("FLY")).toBe("fly");
		expect(parseRunnerName("Cloudflare")).toBe("cloudflare");
		expect(parseRunnerName("lambda")).toBeNull();
	});

	it("builds the runner named by TRANSCODE_RUNNER", () => {
		const env = (runner?: string) => ({ TRANSCODE_RUNNER: runner }) as WorkerEnv;
		expect(createRunner(env())?.name).toBe("cloudflare");
		expect(createRunner(env("fly"))?.name).toBe("fly");
		expect(createRunner(env("cloudflare"))?.name).toBe("cloudflare");
		expect(createRunner(env("http"))?.name).toBe("http");
		expect(createRunner(env("nope"))).toBeNull();
	});

	it("reports the vCPU of each runner for the encode measurement", () => {
		expect(createRunner({ TRANSCODE_RUNNER: "fly", FLY_TRANSCODE_CPUS: "8" } as WorkerEnv)?.cpus).toBe(8);
		expect(createRunner({ TRANSCODE_RUNNER: "cloudflare" } as WorkerEnv)?.cpus).toBe(4);
		expect(
			createRunner({ TRANSCODE_RUNNER: "cloudflare", CF_TRANSCODE_INSTANCE: "standard-3" } as WorkerEnv)?.cpus,
		).toBe(2);
		expect(createRunner({ TRANSCODE_RUNNER: "http", TRANSCODE_RUNNER_CPUS: "16" } as WorkerEnv)?.cpus).toBe(16);
	});

	it("fails loud (500) when the chosen runner is not configured", async () => {
		for (const runner of ["fly", "cloudflare", "http"]) {
			const result = await createRunner({ TRANSCODE_RUNNER: runner } as WorkerEnv)?.launch(job);
			expect(result).toMatchObject({
				ok: false,
				status: 500,
				error: "Transcode runner not configured",
				code: "transcode_not_configured",
			});
		}
	});
});

describe("HttpRunner", () => {
	const env = { TRANSCODE_RUNNER_URL: "https://runner.example/jobs/", TRANSCODE_RUNNER_SECRET: "s3cret" };

	function stubRunner(...responses: Response[]) {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				calls.push({ url, init });
				return responses.shift() ?? new Response("gone", { status: 500 });
			}),
		);
		return calls;
	}

	it("POSTs the job with the bearer secret, the command and the script in env", async () => {
		const calls = stubRunner(Response.json({ jobId: "vps-42" }, { status: 202 }));
		const result = await createHttpRunner(env, noWait).launch(job);
		expect(result).toEqual({ ok: true, jobRef: "vps-42" });

		const [call] = calls;
		expect(call?.url).toBe("https://runner.example/jobs");
		expect(call?.init.method).toBe("POST");
		expect(call?.init.headers).toMatchObject({ Authorization: "Bearer s3cret" });
		const body = JSON.parse(String(call?.init.body)) as HttpRunnerJobRequest;
		expect(body).toEqual({
			version: 1,
			videoId: "vid1",
			command: ["sh", "-c", RUN_SCRIPT_COMMAND],
			env: { ...job.env, [SCRIPT_ENV_VAR]: btoa("echo hi") },
		});
	});

	it("falls back to a videoId job ref when the runner returns no jobId", async () => {
		stubRunner(new Response(null, { status: 204 }));
		expect(await createHttpRunner(env, noWait).launch(job)).toEqual({ ok: true, jobRef: "http-vid1" });
	});

	it("retries a busy runner and fails loud with 503 when it stays busy", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const calls = stubRunner(...Array.from({ length: 5 }, () => new Response("busy", { status: 429 })));
		const result = await createHttpRunner(env, noWait).launch(job);
		expect(result).toMatchObject({ ok: false, status: 503, code: "transcode_runner_unavailable", detail: "busy" });
		expect(calls).toHaveLength(5);
	});

	it("does not retry a rejected job (401/400) and reports 500", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const calls = stubRunner(new Response("bad secret", { status: 401 }));
		expect(await createHttpRunner(env, noWait).launch(job)).toMatchObject({
			ok: false,
			status: 500,
			code: "transcode_launch_failed",
		});
		expect(calls).toHaveLength(1);
	});
});

describe("CloudflareContainerRunner", () => {
	function fakeNamespace(launch = vi.fn(async () => ({ alreadyRunning: false }))) {
		const names: string[] = [];
		const namespace: TranscodeContainerNamespace = {
			idFromName: (name: string) => {
				names.push(name);
				return name as unknown as DurableObjectId;
			},
			get: () => ({ launch, cancel: vi.fn(async () => {}) }),
		};
		return { namespace, names, launch };
	}

	it("launches one Durable Object per video with the instance type and the script in env", async () => {
		const { namespace, names, launch } = fakeNamespace();
		const runner = createCloudflareContainerRunner({ TRANSCODE_CONTAINER: namespace });
		expect(await runner.launch(job)).toEqual({ ok: true, jobRef: "cf-vid1" });
		expect(names).toEqual(["vid1"]);
		expect(launch).toHaveBeenCalledWith({
			instance: "standard-4",
			env: { ...job.env, [SCRIPT_ENV_VAR]: btoa("echo hi") },
		});
	});

	it("rejects an unknown instance type and surfaces RPC failures as 503", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { namespace } = fakeNamespace(
			vi.fn(async () => {
				throw new Error("no capacity");
			}),
		);
		const odd = createCloudflareContainerRunner({ TRANSCODE_CONTAINER: namespace, CF_TRANSCODE_INSTANCE: "huge" });
		expect(await odd.launch(job)).toMatchObject({ ok: false, status: 500 });
		const runner = createCloudflareContainerRunner({ TRANSCODE_CONTAINER: namespace });
		expect(await runner.launch(job)).toMatchObject({ ok: false, status: 503, detail: "Error: no capacity" });
	});
});

describe("TranscodeContainer (Durable Object side)", () => {
	function fakeContainer(running = false) {
		const container = {
			running,
			images: { transcode: "registry.cloudflare.com/acct/transcode:abc" },
			start: vi.fn<ContainerHandle["start"]>(),
			monitor: vi.fn(async () => {}),
			destroy: vi.fn(async () => {}),
		};
		return container;
	}

	it("starts the transcode image with the script entrypoint and env", () => {
		const container = fakeContainer();
		const started = startTranscodeContainer(container, { env: { A: "1" }, instance: "standard-4" });
		expect(started.alreadyRunning).toBe(false);
		expect(container.start).toHaveBeenCalledWith({
			image: "registry.cloudflare.com/acct/transcode:abc",
			instance: "standard-4",
			enableInternet: true,
			entrypoint: ["sh", "-c", RUN_SCRIPT_COMMAND],
			env: { A: "1" },
		});
	});

	it("is idempotent while a container is running", () => {
		const container = fakeContainer(true);
		expect(startTranscodeContainer(container, { env: {}, instance: "standard-4" })).toEqual({
			alreadyRunning: true,
			exited: null,
		});
		expect(container.start).not.toHaveBeenCalled();
	});

	it("reports signal deaths (OOM, host restart) the script trap cannot", () => {
		expect(isUnreportedCrash(Object.assign(new Error("exit"), { exitCode: 137 }))).toBe(true);
		expect(isUnreportedCrash(new Error("stopped"))).toBe(true);
		expect(isUnreportedCrash(Object.assign(new Error("exit"), { exitCode: 1 }))).toBe(false);
	});

	it("emits transcode.failed to the worker webhook after an unreported crash", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const fetchMock = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		const env = { CALLBACK_URL: "https://w/cb", CALLBACK_SECRET: "cb", VIDEO_ID: "vid1" };
		await watchContainer(Promise.reject(Object.assign(new Error("killed"), { exitCode: 137 })), env);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://w/cb");
		expect(init.headers).toMatchObject({ Authorization: "Bearer cb" });
		expect(JSON.parse(String(init.body))).toMatchObject({
			event: "transcode.failed",
			videoId: "vid1",
			retriable: true,
		});

		await watchContainer(Promise.reject(Object.assign(new Error("exit"), { exitCode: 1 })), env);
		await watchContainer(Promise.resolve(), env);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps the runtime's error text out of the forwarded crash event", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const fetchMock = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		const env = { CALLBACK_URL: "https://w/cb", CALLBACK_SECRET: "cb", VIDEO_ID: "vid1" };
		await watchContainer(Promise.reject(new Error("internal host 10.0.0.7 evicted account abc")), env);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(String(init.body)).not.toContain("10.0.0.7");
		expect(JSON.parse(String(init.body))).toMatchObject({ error: "transcode container stopped (unexpectedly)" });
	});
});
