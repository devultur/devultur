import { describe, expect, it } from "vitest";
import type { ObjectLock } from "./lock";
import { canChange, effectiveUntil, isLocked } from "./lock-change";

const DAY = 86_400;
const UPLOADED = "2030-01-01T00:00:00.000Z";
const NOW = "2030-01-02T00:00:00.000Z";
const LATER = "2030-06-01T00:00:00.000Z";
const SOONER = "2030-03-01T00:00:00.000Z";
const PAST = "2029-01-01T00:00:00.000Z";

const compliance = (until: string): ObjectLock => ({ retention: { mode: "compliance", until } });
const governance = (until: string): ObjectLock => ({ retention: { mode: "governance", until } });

describe("effectiveUntil", () => {
	it("is undefined without retention", () => {
		expect(effectiveUntil({})).toBeUndefined();
		expect(effectiveUntil({ hold: true })).toBeUndefined();
	});

	it("returns a fixed until", () => {
		expect(effectiveUntil(compliance(LATER))).toBe(LATER);
	});

	it("counts a period from upload", () => {
		expect(effectiveUntil({ retention: { mode: "compliance", period: DAY } }, { uploadedAt: UPLOADED })).toBe(NOW);
	});

	it("counts a period from hold release when a hold was used", () => {
		const until = effectiveUntil(
			{ retention: { mode: "compliance", period: DAY }, hold: false },
			{ uploadedAt: UPLOADED, holdReleasedAt: NOW },
		);
		expect(until).toBe("2030-01-03T00:00:00.000Z");
	});

	it("is undefined while the hold is still set (the period hasn't started)", () => {
		expect(
			effectiveUntil({ retention: { mode: "compliance", period: DAY }, hold: true }, { uploadedAt: UPLOADED }),
		).toBeUndefined();
	});

	it("accepts Date and epoch timestamps", () => {
		const lock: ObjectLock = { retention: { mode: "governance", period: DAY } };
		expect(effectiveUntil(lock, { uploadedAt: new Date(UPLOADED) })).toBe(NOW);
		expect(effectiveUntil(lock, { uploadedAt: Date.parse(UPLOADED) })).toBe(NOW);
	});

	it("throws when a period has no start", () => {
		expect(() => effectiveUntil({ retention: { mode: "compliance", period: DAY } })).toThrow(RangeError);
	});
});

describe("isLocked", () => {
	it("is false without a lock or after expiry", () => {
		expect(isLocked({}, NOW)).toBe(false);
		expect(isLocked(compliance(PAST), NOW)).toBe(false);
		expect(isLocked(compliance(NOW), NOW)).toBe(false);
	});

	it("is true before until", () => {
		expect(isLocked(governance(LATER), NOW)).toBe(true);
	});

	it("is true while a hold is set, whatever retention says", () => {
		expect(isLocked({ hold: true }, NOW)).toBe(true);
		expect(isLocked({ ...compliance(PAST), hold: true }, NOW)).toBe(true);
	});

	it("uses the period from upload", () => {
		const lock: ObjectLock = { retention: { mode: "compliance", period: 2 * DAY } };
		expect(isLocked(lock, NOW, { uploadedAt: UPLOADED })).toBe(true);
		expect(isLocked(lock, LATER, { uploadedAt: UPLOADED })).toBe(false);
	});
});

describe("canChange", () => {
	const user = { privileged: false, now: NOW };
	const admin = { privileged: true, now: NOW };

	it("allows anything when there was no retention", () => {
		expect(canChange({}, compliance(LATER), user)).toEqual({ ok: true, bypass: false });
		expect(canChange({ hold: true }, {}, user)).toEqual({ ok: true, bypass: false });
	});

	it("allows replacing an expired retention", () => {
		expect(canChange(compliance(PAST), {}, user)).toEqual({ ok: true, bypass: false });
		expect(canChange(compliance(PAST), governance(SOONER), user)).toEqual({ ok: true, bypass: false });
	});

	describe("compliance", () => {
		it("extends", () => {
			expect(canChange(compliance(SOONER), compliance(LATER), user)).toEqual({ ok: true, bypass: false });
			expect(canChange(compliance(SOONER), compliance(SOONER), user)).toEqual({ ok: true, bypass: false });
		});

		it.each([
			["shortening", compliance(SOONER)],
			["removal", {}],
			["switching to governance", governance(LATER)],
			["dropping derivatives", { retention: { mode: "compliance", until: LATER, derivatives: "original-only" } }],
		] as [string, ObjectLock][])("rejects %s even when privileged", (_name, after) => {
			expect(canChange(compliance(LATER), after, admin)).toEqual({ ok: false, reason: "compliance_extend_only" });
		});

		it("allows widening derivatives to inherit", () => {
			const before: ObjectLock = { retention: { mode: "compliance", until: LATER, derivatives: "original-only" } };
			expect(canChange(before, compliance(LATER), user)).toEqual({ ok: true, bypass: false });
		});

		it("compares a period with a fixed until", () => {
			const before: ObjectLock = { retention: { mode: "compliance", period: 30 * DAY } };
			const timing = { uploadedAt: UPLOADED };
			expect(canChange(before, compliance(LATER), { ...user, timing })).toEqual({ ok: true, bypass: false });
			expect(canChange(before, compliance("2030-01-15T00:00:00Z"), { ...user, timing })).toEqual({
				ok: false,
				reason: "compliance_extend_only",
			});
		});
	});

	describe("governance", () => {
		it("extends without privilege", () => {
			expect(canChange(governance(SOONER), governance(LATER), user)).toEqual({ ok: true, bypass: false });
		});

		it("switches to compliance without privilege when not shorter", () => {
			expect(canChange(governance(SOONER), compliance(LATER), user)).toEqual({ ok: true, bypass: false });
		});

		it.each([
			["shortening", governance(SOONER)],
			["removal", {}],
			["dropping derivatives", { retention: { mode: "governance", until: LATER, derivatives: "original-only" } }],
		] as [string, ObjectLock][])("requires privilege for %s", (_name, after) => {
			expect(canChange(governance(LATER), after, user)).toEqual({ ok: false, reason: "lock_privilege_required" });
			expect(canChange(governance(LATER), after, admin)).toEqual({ ok: true, bypass: true });
		});
	});

	describe("holds", () => {
		const held: ObjectLock = { retention: { mode: "compliance", period: DAY }, hold: true };

		it("can be set on a compliance retention", () => {
			expect(canChange(compliance(LATER), { ...compliance(LATER), hold: true }, user)).toEqual({
				ok: true,
				bypass: false,
			});
		});

		it("release starts the period now", () => {
			expect(canChange(held, { ...held, hold: false }, user)).toEqual({ ok: true, bypass: false });
		});

		it("never shortens retention: a hold doesn't excuse an earlier until", () => {
			expect(canChange(compliance(LATER), { ...compliance(SOONER), hold: true }, admin)).toEqual({
				ok: false,
				reason: "compliance_extend_only",
			});
		});

		it("a pending period can't be shortened or swapped for an earlier until", () => {
			const shorter: ObjectLock = { retention: { mode: "compliance", period: 60 }, hold: true };
			expect(canChange(held, shorter, admin)).toEqual({ ok: false, reason: "compliance_extend_only" });
			expect(canChange(held, { ...compliance("2030-01-02T12:00:00Z"), hold: true }, admin)).toEqual({
				ok: false,
				reason: "compliance_extend_only",
			});
		});

		it("a pending period can grow or become an until past now + period", () => {
			const longer: ObjectLock = { retention: { mode: "compliance", period: 2 * DAY }, hold: true };
			expect(canChange(held, longer, user)).toEqual({ ok: true, bypass: false });
			expect(canChange(held, compliance(LATER), user)).toEqual({ ok: true, bypass: false });
		});

		it("a held governance period needs privilege to drop", () => {
			const heldGovernance: ObjectLock = { retention: { mode: "governance", period: DAY }, hold: true };
			expect(canChange(heldGovernance, { hold: true }, user)).toEqual({ ok: false, reason: "lock_privilege_required" });
		});
	});
});
