import { describe, expect, it } from "vitest";
import { nextIndex } from "./use-roving-focus";

// 10 items in 4 columns:  0 1 2 3 / 4 5 6 7 / 8 9
describe("nextIndex", () => {
	it.each([
		["ArrowRight", 5, 6],
		["ArrowLeft", 5, 4],
		["ArrowDown", 5, 9],
		["ArrowUp", 5, 1],
		["ArrowDown", 6, 6],
		["ArrowUp", 2, 2],
		["ArrowLeft", 0, 0],
		["ArrowRight", 9, 9],
		["Home", 7, 0],
		["End", 1, 9],
	])("%s from %i goes to %i", (key, current, expected) => {
		expect(nextIndex(key, current, 10, 4)).toBe(expected);
	});

	it("ignores any other key", () => {
		expect(nextIndex("a", 3, 10, 4)).toBeNull();
	});
});
