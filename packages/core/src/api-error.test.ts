import { describe, expect, it } from "vitest";
import { DevulturApiError, errorFromResponse } from "./api-error";

function jsonResponse(status: number, body: unknown): Response {
	return { ok: false, status, json: async () => body } as unknown as Response;
}

describe("errorFromResponse", () => {
	it("keeps a 409 retention_active body in details", async () => {
		const error = await errorFromResponse(
			jsonResponse(409, {
				error: "object is retained",
				code: "retention_active",
				key: "file/a/doc.pdf",
				mode: "compliance",
				until: "2030-01-01T00:00:00.000Z",
				hold: false,
			}),
		);
		expect(error).toBeInstanceOf(DevulturApiError);
		expect(error.message).toBe("object is retained");
		expect(error.status).toBe(409);
		expect(error.code).toBe("retention_active");
		expect(error.details).toEqual({
			key: "file/a/doc.pdf",
			mode: "compliance",
			until: "2030-01-01T00:00:00.000Z",
			hold: false,
		});
	});

	it("keeps limit as a field and in details", async () => {
		const error = await errorFromResponse(jsonResponse(413, { error: "too big", code: "file_too_large", limit: 10 }));
		expect(error.limit).toBe(10);
		expect(error.details).toEqual({ limit: 10 });
	});

	it("has no details when the body only carries error and code", async () => {
		const error = await errorFromResponse(jsonResponse(400, { error: "bad", code: "invalid" }));
		expect(error.details).toBeUndefined();
	});

	it("falls back to the status when the body isn't JSON or is an array", async () => {
		const notJson = { ok: false, status: 502, json: async () => Promise.reject(new SyntaxError("x")) };
		const fromText = await errorFromResponse(notJson as unknown as Response);
		expect(fromText.message).toBe("API error: 502");
		expect(fromText.details).toBeUndefined();
		const fromArray = await errorFromResponse(jsonResponse(500, ["x"]));
		expect(fromArray.details).toBeUndefined();
	});

	it("stays constructible with the old four arguments", () => {
		const error = new DevulturApiError("too big", 413, "file_too_large", 1);
		expect(error.details).toBeUndefined();
	});
});
