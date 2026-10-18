import { describe, expect, it } from "vitest";
import { areaDownscale } from "./area-resize";

function solid(width: number, height: number, rgba: [number, number, number, number]) {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let index = 0; index < width * height; index += 1) data.set(rgba, index * 4);
	return { data, width, height };
}

describe("areaDownscale", () => {
	it("keeps a solid color across a non-integer ratio", () => {
		const output = areaDownscale(solid(10, 7, [200, 100, 50, 255]), 3, 2);
		for (let index = 0; index < 6; index += 1) {
			expect([...output.subarray(index * 4, index * 4 + 4)]).toEqual([200, 100, 50, 255]);
		}
	});

	it("averages blocks", () => {
		const image = solid(4, 1, [0, 0, 0, 255]);
		image.data.set([255, 255, 255, 255], 0);
		image.data.set([255, 255, 255, 255], 4);
		const output = areaDownscale(image, 2, 1);
		expect([...output]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
	});

	it("does not bleed the color of transparent pixels", () => {
		const image = solid(2, 1, [0, 0, 255, 255]);
		image.data.set([255, 0, 0, 0], 0);
		expect([...areaDownscale(image, 1, 1)]).toEqual([0, 0, 255, 128]);
	});

	it("reads only the requested region", () => {
		const image = solid(4, 4, [0, 0, 0, 255]);
		for (const index of [5, 6, 9, 10]) image.data.set([255, 255, 255, 255], index * 4);
		const output = areaDownscale(image, 1, 1, { x: 1, y: 1, width: 2, height: 2 });
		expect([...output]).toEqual([255, 255, 255, 255]);
	});
});
