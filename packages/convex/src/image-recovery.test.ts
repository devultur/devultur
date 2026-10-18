import { describe, expect, it } from "vitest";
import { isSessionMismatch } from "./image-recovery";

const jsonResponse = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("isSessionMismatch", () => {
	it("true solo para un 401 con code session_mismatch", async () => {
		expect(await isSessionMismatch(jsonResponse(401, { code: "session_mismatch" }))).toBe(true);
	});

	it("false para otro code, body no-JSON, o sin code", async () => {
		expect(await isSessionMismatch(jsonResponse(401, { code: "unauthorized" }))).toBe(false);
		expect(await isSessionMismatch(jsonResponse(401, { error: "nope" }))).toBe(false);
		expect(await isSessionMismatch(new Response("not json", { status: 401 }))).toBe(false);
	});
});
