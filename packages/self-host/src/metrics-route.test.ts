import { describe, expect, it } from "vitest";
import { createWorker } from "./index";

// The Worker doesn't store metrics: the player's beacon is accepted and discarded (no 404 in the console).
describe("POST /v1/metrics/playback (self-host)", () => {
	it("answers 204 without reading the body or any binding", async () => {
		const response = await createWorker().request(
			"/v1/metrics/playback",
			{ method: "POST", body: '{"v":1}', headers: { "Content-Type": "text/plain" } },
			{} as never,
		);
		expect(response.status).toBe(204);
	});
});
