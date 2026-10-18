import { describe, expect, it, vi } from "vitest";
import { backoffDelayMs, fetchWithRetry, isRetryableStatus, parseRetryAfterMs } from "./retry";

function responses(...statuses: Array<number | { status: number; retryAfter: string }>) {
	const queue = [...statuses];
	return vi.fn(async () => {
		const next = queue.shift();
		if (next === undefined) throw new Error("no more responses");
		if (typeof next === "number") return new Response(String(next), { status: next });
		return new Response("limited", { status: next.status, headers: { "Retry-After": next.retryAfter } });
	});
}

describe("isRetryableStatus", () => {
	it("retries 429 and 5xx only", () => {
		expect([429, 500, 502, 503].every(isRetryableStatus)).toBe(true);
		expect([200, 400, 401, 404, 412, 422].some(isRetryableStatus)).toBe(false);
	});
});

describe("parseRetryAfterMs", () => {
	it("reads seconds and HTTP dates; ignores garbage", () => {
		expect(parseRetryAfterMs("3")).toBe(3000);
		expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
		expect(parseRetryAfterMs("soon")).toBeNull();
		expect(parseRetryAfterMs(null)).toBeNull();
	});
});

describe("backoffDelayMs", () => {
	it("grows exponentially, capped, with full jitter", () => {
		const top = () => 0.999_999;
		expect(backoffDelayMs(0, { random: top })).toBe(499);
		expect(backoffDelayMs(2, { random: top })).toBe(1999);
		expect(backoffDelayMs(10, { random: top })).toBe(7999);
		expect(backoffDelayMs(3, { random: () => 0 })).toBe(0);
	});
});

describe("fetchWithRetry", () => {
	it("retries 429/5xx until success", async () => {
		const send = responses(429, 503, 201);
		const sleep = vi.fn(async (_delayMs: number) => {});
		const response = await fetchWithRetry(send, { sleep, random: () => 0.5 });
		expect(response.status).toBe(201);
		expect(send).toHaveBeenCalledTimes(3);
		expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([250, 500]);
	});

	it("honors Retry-After over the jittered backoff (bounded)", async () => {
		const sleep = vi.fn(async (_delayMs: number) => {});
		await fetchWithRetry(responses({ status: 429, retryAfter: "2" }, { status: 429, retryAfter: "3600" }, 200), {
			sleep,
		});
		expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([2000, 30_000]);
	});

	it("gives up after maxAttempts and returns the last response (caller fails loud)", async () => {
		const send = responses(429, 429, 429, 429, 429, 200);
		const response = await fetchWithRetry(send, { sleep: async () => {} });
		expect(response.status).toBe(429);
		expect(send).toHaveBeenCalledTimes(5);
	});

	it("does not retry non-retryable errors", async () => {
		const send = responses(422);
		const response = await fetchWithRetry(send, { sleep: async () => {} });
		expect(response.status).toBe(422);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("retries network errors and rethrows the last one", async () => {
		const send = vi.fn(async () => {
			throw new Error("connection reset");
		});
		await expect(fetchWithRetry(send, { maxAttempts: 3, sleep: async () => {} })).rejects.toThrow("connection reset");
		expect(send).toHaveBeenCalledTimes(3);
	});
});
