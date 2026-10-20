import { describe, expect, it } from "vitest";
import type { UploadGrant } from "../export-types";
import { uploadGrantFromClaims } from "../routes/token-upload";
import { resolveUploadLock } from "./upload-lock";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const DAY = 86_400;
const GRANT: UploadGrant = { tokenId: "t", pathPrefix: "asset/x/", visibility: "private" };

describe("resolveUploadLock", () => {
	it("is off without a request, token or default lock", () => {
		expect(resolveUploadLock({ now: NOW })).toBeUndefined();
		expect(resolveUploadLock({ now: NOW, hold: false })).toBeUndefined();
	});

	it("request → app default, with derivatives defaulted", () => {
		expect(resolveUploadLock({ now: NOW, appDefault: { retention: { mode: "governance", period: DAY } } })).toEqual({
			retention: { mode: "governance", period: DAY, derivatives: "inherit" },
			hold: false,
		});
		expect(
			resolveUploadLock({
				now: NOW,
				lock: { retention: { mode: "compliance", period: 2 * DAY } },
				appDefault: { retention: { mode: "governance", period: DAY } },
			}),
		).toEqual({ retention: { mode: "compliance", period: 2 * DAY, derivatives: "inherit" }, hold: false });
	});

	it("accepts a hold at upload, alone or next to a lock", () => {
		expect(resolveUploadLock({ now: NOW, hold: true })).toEqual({ hold: true });
		expect(
			resolveUploadLock({ now: NOW, lock: { retention: { mode: "compliance", period: DAY } }, hold: true }),
		).toEqual({ retention: { mode: "compliance", period: DAY, derivatives: "inherit" }, hold: true });
	});

	it("rejects an invalid lock or hold with 400 invalid_lock", () => {
		expect(resolveUploadLock({ now: NOW, lock: { retention: { mode: "compliance" } } })).toMatchObject({
			status: 400,
			code: "invalid_lock",
		});
		expect(resolveUploadLock({ now: NOW, hold: "yes" })).toMatchObject({ status: 400, code: "invalid_lock" });
		expect(resolveUploadLock({ now: NOW, lock: "forever" })).toMatchObject({ status: 400, code: "invalid_lock" });
	});

	describe("upload token minimum", () => {
		const grant: UploadGrant = { ...GRANT, lock: { retention: { mode: "compliance", period: 30 * DAY } } };

		it("applies the token's lock when the request names none", () => {
			expect(resolveUploadLock({ now: NOW, grant })).toEqual({
				retention: { mode: "compliance", period: 30 * DAY, derivatives: "inherit" },
				hold: false,
			});
		});

		it("lets the request make it stricter", () => {
			const lock = { retention: { mode: "compliance", period: 60 * DAY } };
			expect(resolveUploadLock({ now: NOW, grant, lock })).toMatchObject({ retention: { period: 60 * DAY } });
		});

		it.each([
			["a shorter period", { retention: { mode: "compliance", period: DAY } }],
			["governance instead of compliance", { retention: { mode: "governance", period: 30 * DAY } }],
			["original-only", { retention: { mode: "compliance", period: 30 * DAY, derivatives: "original-only" } }],
		])("refuses %s with 403 lock_below_minimum", (_name, lock) => {
			expect(resolveUploadLock({ now: NOW, grant, lock })).toMatchObject({ status: 403, code: "lock_below_minimum" });
		});

		it("refuses dropping a pinned hold", () => {
			const held: UploadGrant = { ...GRANT, lock: { hold: true } };
			expect(resolveUploadLock({ now: NOW, grant: held, hold: false })).toMatchObject({ code: "lock_below_minimum" });
			expect(resolveUploadLock({ now: NOW, grant: held })).toEqual({ hold: true });
		});
	});

	describe("expiry", () => {
		it("rejects a file that would expire before its retention ends", () => {
			const lock = { retention: { mode: "compliance", period: 2 * DAY } };
			expect(resolveUploadLock({ now: NOW, lock, expiresAt: NOW + DAY * 1000 })).toMatchObject({
				status: 400,
				code: "lock_conflicts_expiry",
			});
			expect(resolveUploadLock({ now: NOW, lock, expiresAt: NOW + 3 * DAY * 1000 })).toMatchObject({
				retention: { period: 2 * DAY },
			});
		});

		it("rejects any expiry on a held file (a hold has no end)", () => {
			expect(resolveUploadLock({ now: NOW, hold: true, expiresAt: NOW + 365 * DAY * 1000 })).toMatchObject({
				code: "lock_conflicts_expiry",
			});
		});

		it("accepts an expiry with no lock, or after a fixed until", () => {
			expect(resolveUploadLock({ now: NOW, expiresAt: NOW + 1000 })).toBeUndefined();
			const lock = { retention: { mode: "governance", until: "2030-01-02T00:00:00Z" } };
			expect(resolveUploadLock({ now: NOW, lock, expiresAt: NOW + 2 * DAY * 1000 })).toMatchObject({
				retention: { until: "2030-01-02T00:00:00Z" },
			});
		});
	});
});

describe("upload token lock claim", () => {
	const claims = { typ: "upload", res: "asset/x/", jti: "j", visibility: "private" };

	it("carries a valid lock into the grant", () => {
		expect(uploadGrantFromClaims({ ...claims, lock: { hold: true } })).toMatchObject({ lock: { hold: true } });
		expect(uploadGrantFromClaims(claims)).not.toHaveProperty("lock");
	});

	it("refuses a token whose lock claim isn't valid", () => {
		expect(uploadGrantFromClaims({ ...claims, lock: { hold: "yes" } })).toBeNull();
	});
});
