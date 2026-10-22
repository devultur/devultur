import type { DevulturMedia } from "@devultur/core";
import type { Infer } from "convex/values";
import { describe, expectTypeOf, it } from "vitest";
import { dv } from "./validators";

// A `DevulturMedia` returned by an upload must fit a mutation argument validated with `dv.media()`.
describe("dv.media()", () => {
	it("accepts every DevulturMedia, tags included", () => {
		const validator = dv.media();
		expectTypeOf<DevulturMedia>().toExtend<Infer<typeof validator>>();
	});
});
