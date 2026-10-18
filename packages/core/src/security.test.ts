import { describe, expect, it } from "vitest";
import { computeFingerprint, DEFAULT_SECURITY, resolveSecurity } from "./security";

describe("resolveSecurity", () => {
	it("secure-by-default: session on, ip + encrypt off", () => {
		expect(resolveSecurity()).toEqual({ sessionBinding: true, ipBinding: false, encrypt: false });
		expect(DEFAULT_SECURITY).toEqual({ sessionBinding: true, ipBinding: false, encrypt: false });
	});

	it("resource overrides config, config overrides default (per flag)", () => {
		const resolved = resolveSecurity({ encrypt: true }, { ipBinding: true, encrypt: false });
		expect(resolved).toEqual({ sessionBinding: true, ipBinding: true, encrypt: true });
	});

	it("can turn off session binding explicitly", () => {
		expect(resolveSecurity({ sessionBinding: false }).sessionBinding).toBe(false);
	});
});

describe("computeFingerprint", () => {
	it("is deterministic (same inputs → same fingerprint)", async () => {
		const a = await computeFingerprint("user-1", "UA/1.0", "nonce-abc");
		const b = await computeFingerprint("user-1", "UA/1.0", "nonce-abc");
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it("fp (without ip) != fpip (with ip)", async () => {
		const fp = await computeFingerprint("user-1", "UA/1.0", "nonce-abc");
		const fpip = await computeFingerprint("user-1", "UA/1.0", "nonce-abc", "1.2.3.4");
		expect(fp).not.toBe(fpip);
	});

	it("changes with any component (UA, nonce, ip)", async () => {
		const base = await computeFingerprint("user-1", "UA/1.0", "nonce-abc", "1.2.3.4");
		expect(await computeFingerprint("user-1", "UA/2.0", "nonce-abc", "1.2.3.4")).not.toBe(base);
		expect(await computeFingerprint("user-1", "UA/1.0", "nonce-xyz", "1.2.3.4")).not.toBe(base);
		expect(await computeFingerprint("user-1", "UA/1.0", "nonce-abc", "9.9.9.9")).not.toBe(base);
	});
});
