// A lock change requested through `PUT /v1/lock/:key`: the next lock from the current one and the request, and what
// kind of change it is. Pure.
import { canChange, type ObjectLock, validateLock } from "@devultur/core";
import type { LockChangeAction } from "../plugin-hooks";
import type { LockState } from "./state";

/** The body of `PUT /v1/lock/:key`. Holds are a separate request. */
export interface LockChangeBody {
	mode?: unknown;
	until?: unknown;
	period?: unknown;
	derivatives?: unknown;
	/** Drop the retention (a governance one, with `bypassGovernance`). */
	remove?: unknown;
	/** Ask to shorten or remove a governance retention: needs an `authorizeLockChange` hook's approval. */
	bypassGovernance?: unknown;
}

const BODY_FIELDS = new Set(["mode", "until", "period", "derivatives", "remove", "bypassGovernance"]);

export type NextLock = { ok: true; lock: ObjectLock } | { ok: false; errors: string[] };

/**
 * The lock after the change: the request's fields over the current retention. `until` and `period` replace each other
 * (the request's wins). The hold is kept as is.
 */
export function nextLock(before: ObjectLock | null, body: LockChangeBody): NextLock {
	const unknown = Object.keys(body).filter((field) => !BODY_FIELDS.has(field));
	if (unknown.length > 0) return { ok: false, errors: unknown.map((field) => `${field}: unknown field`) };
	if (body.remove !== undefined && body.remove !== true) return { ok: false, errors: ["remove: must be true"] };
	const hold = before?.hold === true;
	if (body.remove === true) return { ok: true, lock: { hold } };

	const current = before?.retention;
	const isExpiryChanged = body.until !== undefined || body.period !== undefined;
	const retention: Record<string, unknown> = {
		mode: body.mode ?? current?.mode,
		...(isExpiryChanged
			? {
					...(body.until !== undefined ? { until: body.until } : {}),
					...(body.period !== undefined ? { period: body.period } : {}),
				}
			: {
					...(current?.until ? { until: current.until } : {}),
					...(current?.period ? { period: current.period } : {}),
				}),
		derivatives: body.derivatives ?? current?.derivatives ?? "inherit",
	};
	const validation = validateLock({ retention, hold });
	if (!validation.ok) return validation;
	return { ok: true, lock: validation.lock };
}

export const timingOf = (state: LockState | null) => ({
	uploadedAt: state?.uploadedAt,
	holdReleasedAt: state?.holdReleasedAt,
});

/** What the change does, judged without privilege: anything `canChange` refuses unprivileged shortens or removes. */
export function classifyChange(state: LockState | null, after: ObjectLock, now: Date): LockChangeAction {
	const before = state?.lock ?? {};
	const isActive = canChange(before, { hold: before.hold }, { privileged: false, now, timing: timingOf(state) });
	// Dropping the retention is free only when there's no active one: then this is a first (or fresh) `set`.
	if (isActive.ok) return after.retention ? "set" : "remove";
	if (!after.retention) return "remove";
	const change = canChange(before, after, { privileged: false, now, timing: timingOf(state) });
	return change.ok ? "extend" : "shorten";
}
