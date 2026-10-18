import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerClient, DevulturApiError } from "./worker-client";

const BASE = "https://api.test";
const API_KEY = "sk_test";
const file = new File(["hi"], "clip.mp4", { type: "video/mp4" });

// Minimal Response: only what the client consumes (.ok/.status/.json/.text). We mock the `fetch`
// boundary, not the worker → pure tests with no bindings or Fly.
function jsonResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

function nonJsonResponse(status: number, text: string): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => {
			throw new SyntaxError("not json");
		},
		text: async () => text,
	} as unknown as Response;
}

const uploadPost = jsonResponse(200, { uploadUrl: "/v1/upload/put/abc", key: "video/x/raw/clip.mp4", id: "x" });

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("DevulturApiError", () => {
	it("is an Error that preserves status, code and limit", () => {
		const error = new DevulturApiError("too big", 413, "file_too_large", 104857600);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("DevulturApiError");
		expect(error.status).toBe(413);
		expect(error.code).toBe("file_too_large");
		expect(error.limit).toBe(104857600);
	});
});

describe("createWorkerClient().uploadFile", () => {
	// The PUT is where the worker enforces limits; without checking response.ok a 413 was swallowed
	// as a successful upload.
	it("throws DevulturApiError when the PUT rejects with a 413 limit error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) =>
				init?.method === "POST"
					? uploadPost
					: jsonResponse(413, {
							error: "file exceeds configured maxSizeBytes",
							code: "file_too_large",
							limit: 104857600,
						}),
			),
		);

		await expect(createWorkerClient(API_KEY, BASE).uploadFile(file)).rejects.toMatchObject({
			name: "DevulturApiError",
			status: 413,
			code: "file_too_large",
			limit: 104857600,
		});
	});

	it("returns the result when the PUT succeeds", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? uploadPost : jsonResponse(200, {}))),
		);

		const result = await createWorkerClient(API_KEY, BASE).uploadFile(file);
		expect(result).toMatchObject({ key: "video/x/raw/clip.mp4", id: "x", size: file.size });
	});

	it("throws DevulturApiError from the initial POST when the API rejects", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(401, { error: "invalid api key", code: "unauthorized" })),
		);

		await expect(createWorkerClient(API_KEY, BASE).uploadFile(file)).rejects.toMatchObject({
			name: "DevulturApiError",
			status: 401,
			message: "invalid api key",
			code: "unauthorized",
		});
	});

	it("falls back to a generic message when the error body isn't JSON", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => nonJsonResponse(500, "<html>gateway</html>")),
		);

		const error = (await createWorkerClient(API_KEY, BASE)
			.uploadFile(file)
			.catch((thrown) => thrown)) as DevulturApiError;
		expect(error).toBeInstanceOf(DevulturApiError);
		expect(error.status).toBe(500);
		expect(error.message).toBe("API error: 500");
		expect(error.code).toBeUndefined();
		expect(error.limit).toBeUndefined();
	});
});
