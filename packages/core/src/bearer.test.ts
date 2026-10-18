import { describe, expect, it } from "vitest";
import { isBearerOf, timingSafeEqual } from "./bearer";
import { createHTTPWebhookHandler } from "./webhook";

describe("timingSafeEqual", () => {
	it("is true only for identical strings", () => {
		expect(timingSafeEqual("Bearer abc", "Bearer abc")).toBe(true);
		expect(timingSafeEqual("Bearer abd", "Bearer abc")).toBe(false);
		expect(timingSafeEqual("Bearer ab", "Bearer abc")).toBe(false);
		expect(timingSafeEqual("Bearer abcd", "Bearer abc")).toBe(false);
		expect(timingSafeEqual("Bearer ábc", "Bearer abc")).toBe(false);
	});
});

describe("isBearerOf", () => {
	it("accepts the exact bearer of the secret", () => {
		expect(isBearerOf("Bearer s3cret", "s3cret")).toBe(true);
	});

	it.each([
		["a missing secret", "Bearer undefined", undefined],
		["a null secret", "Bearer null", null],
		["an empty secret", "Bearer ", ""],
	])("fails closed with %s", (_label, header, secret) => {
		expect(isBearerOf(header, secret)).toBe(false);
	});

	it.each([
		["no header", null],
		["an empty header", ""],
		["another secret", "Bearer other"],
		["the secret without the scheme", "s3cret"],
		["a lowercase scheme", "bearer s3cret"],
	])("rejects %s", (_label, header) => {
		expect(isBearerOf(header, "s3cret")).toBe(false);
	});
});

describe("createHTTPWebhookHandler", () => {
	function post(authorization?: string) {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (authorization !== undefined) headers.Authorization = authorization;
		return new Request("https://app.test/webhook", {
			method: "POST",
			headers,
			body: JSON.stringify({ event: "transcode.started" }),
		});
	}

	it("returns the event for the configured bearer", async () => {
		const { handler } = createHTTPWebhookHandler({ secret: "s3cret" });
		expect(await handler(null, post("Bearer s3cret"))).toEqual({ event: { event: "transcode.started" } });
	});

	it("rejects a wrong bearer with 401", async () => {
		const { handler } = createHTTPWebhookHandler({ secret: "s3cret" });
		const result = await handler(null, post("Bearer nope"));
		expect(result).toBeInstanceOf(Response);
		expect((result as Response).status).toBe(401);
	});

	it.each(["Bearer ", "Bearer", undefined])("rejects %s when the secret is empty", async (authorization) => {
		const { handler } = createHTTPWebhookHandler({ secret: "" });
		const result = await handler(null, post(authorization));
		expect((result as Response).status).toBe(401);
	});
});
