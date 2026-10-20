import { describe, expect, it } from "vitest";
import { isIsoInstant, resolveLock, validateLock } from "./lock";

const FUTURE = "2030-01-01T00:00:00Z";

describe("isIsoInstant", () => {
	it.each([
		"2030-01-01T00:00:00Z",
		"2030-01-01T00:00Z",
		"2030-01-01T00:00:00.123Z",
		"2030-01-01T05:00:00+05:00",
		"2000-01-01T00:00:00Z",
	])("accepts %s", (value) => {
		expect(isIsoInstant(value)).toBe(true);
	});

	it.each([
		"2030-01-01",
		"2030-01-01T00:00:00",
		"2030-13-01T00:00:00Z",
		"tomorrow",
		"",
		1893456000000,
		undefined,
	])("rejects %s", (value) => {
		expect(isIsoInstant(value)).toBe(false);
	});
});

describe("validateLock", () => {
	it("accepts until, period, derivatives and hold", () => {
		expect(validateLock({ retention: { mode: "compliance", until: FUTURE } })).toEqual({
			ok: true,
			lock: { retention: { mode: "compliance", until: FUTURE } },
		});
		expect(
			validateLock({ retention: { mode: "governance", period: 86400, derivatives: "original-only" }, hold: true }),
		).toEqual({
			ok: true,
			lock: { retention: { mode: "governance", period: 86400, derivatives: "original-only" }, hold: true },
		});
		expect(validateLock({})).toEqual({ ok: true, lock: {} });
	});

	it("accepts a past until (expired, not invalid)", () => {
		expect(validateLock({ retention: { mode: "compliance", until: "2001-01-01T00:00:00Z" } }).ok).toBe(true);
	});

	it("rejects until and period together", () => {
		const result = validateLock({ retention: { mode: "compliance", until: FUTURE, period: 60 } });
		expect(result).toEqual({ ok: false, errors: ["lock.retention: set either until or period, not both"] });
	});

	it("requires until or period", () => {
		const result = validateLock({ retention: { mode: "compliance" } });
		expect(result).toEqual({ ok: false, errors: ["lock.retention: until or period is required"] });
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "60"])("rejects period %s", (period) => {
		const result = validateLock({ retention: { mode: "compliance", period } });
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.errors).toContain("lock.retention.period: must be a positive integer number of seconds");
	});

	it("rejects a bad mode, until, derivatives and hold", () => {
		const result = validateLock({ retention: { mode: "legal", until: "soon", derivatives: "none" }, hold: "yes" });
		expect(result).toEqual({
			ok: false,
			errors: [
				'lock.retention.mode: must be "governance" or "compliance"',
				"lock.retention.until: must be an ISO 8601 date-time with a zone",
				'lock.retention.derivatives: must be "inherit" or "original-only"',
				"lock.hold: must be a boolean",
			],
		});
	});

	it("rejects unknown fields and non-objects", () => {
		expect(validateLock({ legalHold: true })).toEqual({ ok: false, errors: ["lock.legalHold: unknown field"] });
		expect(validateLock({ retention: { mode: "compliance", period: 1, days: 1 } })).toEqual({
			ok: false,
			errors: ["lock.retention.days: unknown field"],
		});
		expect(validateLock(null)).toEqual({ ok: false, errors: ["lock: must be an object"] });
		expect(validateLock({ retention: [] })).toEqual({ ok: false, errors: ["lock.retention: must be an object"] });
	});
});

describe("resolveLock", () => {
	it("is off by default", () => {
		expect(resolveLock()).toEqual({ ok: true, lock: { hold: false } });
	});

	it("uses the app default when the resource sets nothing", () => {
		expect(resolveLock(undefined, { retention: { mode: "governance", period: 60 }, hold: true })).toEqual({
			ok: true,
			lock: { retention: { mode: "governance", period: 60, derivatives: "inherit" }, hold: true },
		});
	});

	it("resource retention replaces the default as a whole (until and period never mix)", () => {
		const result = resolveLock(
			{ retention: { mode: "compliance", until: FUTURE } },
			{ retention: { mode: "governance", period: 60 } },
		);
		expect(result).toEqual({
			ok: true,
			lock: { retention: { mode: "compliance", until: FUTURE, derivatives: "inherit" }, hold: false },
		});
	});

	it("resolves derivatives per field: resource → default → inherit", () => {
		const fromDefault = resolveLock(
			{ retention: { mode: "compliance", period: 60 } },
			{ retention: { mode: "governance", period: 1, derivatives: "original-only" } },
		);
		expect(fromDefault.ok && fromDefault.lock.retention?.derivatives).toBe("original-only");
		const fromResource = resolveLock(
			{ retention: { mode: "compliance", period: 60, derivatives: "inherit" } },
			{ retention: { mode: "governance", period: 1, derivatives: "original-only" } },
		);
		expect(fromResource.ok && fromResource.lock.retention?.derivatives).toBe("inherit");
	});

	it("resolves hold on its own: resource false overrides a default true", () => {
		expect(resolveLock({ hold: false }, { hold: true })).toEqual({ ok: true, lock: { hold: false } });
		expect(resolveLock({ retention: { mode: "compliance", period: 5 } }, { hold: true })).toEqual({
			ok: true,
			lock: { retention: { mode: "compliance", period: 5, derivatives: "inherit" }, hold: true },
		});
	});

	it("reports errors from both levels with their path", () => {
		const result = resolveLock(
			{ retention: { mode: "compliance", period: -1 } },
			{ retention: { mode: "governance", until: "x" } },
		);
		expect(result).toEqual({
			ok: false,
			errors: [
				"lock.retention.period: must be a positive integer number of seconds",
				"default.retention.until: must be an ISO 8601 date-time with a zone",
			],
		});
	});
});
