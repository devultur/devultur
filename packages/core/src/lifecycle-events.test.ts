import { describe, expect, it } from "vitest";
import { isNewerEvent } from "./lifecycle-events";

describe("isNewerEvent", () => {
	const at = "2030-01-01T00:00:01.000Z";

	it("orders by occurredAt", () => {
		expect(isNewerEvent({ occurredAt: "2030-01-01T00:00:02Z", id: "evt_a" }, { occurredAt: at, id: "evt_b" })).toBe(
			true,
		);
		expect(isNewerEvent({ occurredAt: "2030-01-01T00:00:00Z", id: "evt_c" }, { occurredAt: at, id: "evt_b" })).toBe(
			false,
		);
		expect(isNewerEvent({ occurredAt: at, id: "evt_a" }, undefined)).toBe(true);
	});

	it("breaks a tie by id, the same way in either arrival order", () => {
		const first = { occurredAt: at, id: "evt_1" };
		const second = { occurredAt: at, id: "evt_2" };

		expect(isNewerEvent(second, first)).toBe(true);
		expect(isNewerEvent(first, second)).toBe(false);
		expect(isNewerEvent(first, first)).toBe(false);
	});

	it("takes a tie as newer when the last one's id isn't known", () => {
		expect(isNewerEvent({ occurredAt: at, id: "evt_1" }, at)).toBe(true);
	});
});
