// Expiry and change rules for an object lock. Pure: the caller passes the clock (`now`) and the
// object's timestamps, so the Worker and tests evaluate them identically.

import type { ObjectLock, Retention } from "./lock";

/** A point in time: a `Date`, an ISO 8601 string or epoch milliseconds. */
export type LockInstant = Date | string | number;

export interface LockTiming {
	/** When the object was uploaded: a `period` without a hold counts from here. */
	uploadedAt?: LockInstant;
	/** When the hold was released: a `period` counts from here instead when a hold was used. */
	holdReleasedAt?: LockInstant;
}

export type LockChangeReason = "compliance_extend_only" | "lock_privilege_required";

/** `bypass`: the change shortened or removed a governance retention, so it used the privilege (audit it). */
export type LockChange = { ok: true; bypass: boolean } | { ok: false; reason: LockChangeReason };

export interface LockChangeOptions {
	/** The caller passed the app's `authorizeLockChange` check. */
	privileged: boolean;
	now: LockInstant;
	/** Needed when either side has a `period` without a hold. */
	timing?: LockTiming;
}

const toMs = (instant: LockInstant): number =>
	instant instanceof Date ? instant.getTime() : new Date(instant).getTime();

// `pending`: a period waiting for a hold release, so its end isn't known yet.
type RetentionEnd = { kind: "none" } | { kind: "at"; ms: number } | { kind: "pending"; period: number };

function retentionEnd(lock: ObjectLock, timing?: LockTiming): RetentionEnd {
	const { retention } = lock;
	if (!retention) return { kind: "none" };
	if (retention.until !== undefined) return { kind: "at", ms: toMs(retention.until) };
	const period = retention.period ?? 0;
	if (lock.hold) return { kind: "pending", period };
	const start = timing?.holdReleasedAt ?? timing?.uploadedAt;
	if (start === undefined) throw new RangeError("lock: a retention period needs uploadedAt or holdReleasedAt");
	return { kind: "at", ms: toMs(start) + period * 1000 };
}

/**
 * The retention expiry as an ISO string. `undefined` when there is no retention, or when a period
 * is still waiting for its hold to be released (the object stays locked by the hold meanwhile).
 */
export function effectiveUntil(lock: ObjectLock, timing?: LockTiming): string | undefined {
	const end = retentionEnd(lock, timing);
	return end.kind === "at" ? new Date(end.ms).toISOString() : undefined;
}

/** True while a hold is set or the retention hasn't expired. Delete and overwrite are rejected meanwhile. */
export function isLocked(lock: ObjectLock, now: LockInstant, timing?: LockTiming): boolean {
	if (lock.hold) return true;
	const end = retentionEnd(lock, timing);
	return end.kind === "at" && toMs(now) < end.ms;
}

/** Releasing a hold in this change starts the period now. */
function afterTiming(before: ObjectLock, after: ObjectLock, options: LockChangeOptions): LockTiming | undefined {
	if (!before.hold || after.hold) return options.timing;
	return { ...options.timing, holdReleasedAt: options.now };
}

// A pending period ends at the earliest `now + period` (its hold released right now).
function earliestEndMs(end: RetentionEnd, nowMs: number): number {
	if (end.kind === "none") return Number.NEGATIVE_INFINITY;
	return end.kind === "at" ? end.ms : nowMs + end.period * 1000;
}

function isShortened(beforeEnd: RetentionEnd, afterEnd: RetentionEnd, nowMs: number): boolean {
	if (afterEnd.kind === "none") return true;
	return earliestEndMs(afterEnd, nowMs) < earliestEndMs(beforeEnd, nowMs);
}

function isWeakerSetting(before: Retention, after: Retention | undefined): boolean {
	if (!after) return true;
	if (before.mode === "compliance" && after.mode === "governance") return true;
	return (before.derivatives ?? "inherit") === "inherit" && after.derivatives === "original-only";
}

function isRetentionActive(end: RetentionEnd, nowMs: number): boolean {
	if (end.kind === "pending") return true;
	return end.kind === "at" && nowMs < end.ms;
}

/**
 * Whether a lock may go from `before` to `after` (both already validated). Holds can always be set
 * and released, and releasing one starts its period now. While a retention is active: `compliance`
 * only extends (no earlier expiry, no switch to governance, no `original-only`); `governance` is
 * shortened, weakened or removed only with `privileged`. An expired retention can be replaced freely.
 */
export function canChange(before: ObjectLock, after: ObjectLock, options: LockChangeOptions): LockChange {
	const nowMs = toMs(options.now);
	const beforeEnd = retentionEnd(before, options.timing);
	if (!before.retention || !isRetentionActive(beforeEnd, nowMs)) return { ok: true, bypass: false };

	const afterEnd = retentionEnd(after, afterTiming(before, after, options));
	const isWeakened = isShortened(beforeEnd, afterEnd, nowMs) || isWeakerSetting(before.retention, after.retention);
	if (!isWeakened) return { ok: true, bypass: false };
	if (before.retention.mode === "compliance") return { ok: false, reason: "compliance_extend_only" };
	if (!options.privileged) return { ok: false, reason: "lock_privilege_required" };
	return { ok: true, bypass: true };
}
