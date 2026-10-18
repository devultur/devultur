import { computeOutputSize } from "@devultur/react";
import { describe, expect, it } from "vitest";

// The bake geometry (capping width to maxWidth without distorting) is the only part of the cropper
// testable without canvas. Encode/orientation/alpha are browser-only and verified in the browser.
describe("computeOutputSize — width cap without distortion", () => {
	it("does not scale if the crop fits under maxWidth", () => {
		expect(computeOutputSize(1000, 562, 2048)).toEqual({ width: 1000, height: 562 });
	});

	it("caps to maxWidth preserving the aspect ratio", () => {
		// 4000×2250 (16:9) with cap 2048 → 2048×1152.
		expect(computeOutputSize(4000, 2250, 2048)).toEqual({ width: 2048, height: 1152 });
	});

	it("square crop is capped while staying square", () => {
		expect(computeOutputSize(3000, 3000, 1200)).toEqual({ width: 1200, height: 1200 });
	});

	it("invalid dimensions → 0", () => {
		expect(computeOutputSize(0, 100, 2048)).toEqual({ width: 0, height: 0 });
	});
});
