// `POST /v1/lock/hold`: set or release a hold on objects, by a list of keys or by prefix (#4). This is the one way to
// change a hold, a single object included (`keys: [key]`); `PUT /v1/lock/:key` changes the retention only.
// - A hold never touches the retention, so it can only extend protection (a hold on a compliance object is allowed).
// - Releasing a hold on a retention with a `period` starts the period now (`holdReleasedAt`); without one, the object
//   is free once released (unless a fixed `until` still holds it).
// - Each page goes through `authorizeLockChange` (`hold` / `release`) once; every object changed is audited.
// A page is at most HOLD_PAGE_SIZE objects: each costs about four subrequests (head, sidecar read, sidecar write,
// audit record), which keeps a page well under the Workers limit. A prefix walks the bucket with `cursor`.
import { type ObjectLock, validateLock } from "@devultur/core";
import type { Context } from "hono";
import { storageKey } from "../helpers";
import { isVariantKey } from "../image/transform-plan";
import { decideLockChange } from "../plugin-hooks";
import { getRequestState } from "../request-state";
import type { WorkerApp } from "../types";
import { recordLockAudit } from "./audit";
import { isReservedLockKey } from "./guard";
import { effectiveLock, type LockSidecar, objectVersionOf, writeSidecar } from "./sidecar";

/** Objects changed per request: a list of keys may name at most this many; a prefix is walked this many at a time. */
export const HOLD_PAGE_SIZE = 50;

type HoldContext = Context<WorkerApp>;

interface HoldBody {
	hold?: unknown;
	keys?: unknown;
	prefix?: unknown;
	cursor?: unknown;
}

type HoldTargets = { keys: string[]; prefix?: string; cursor?: string } | { error: string };

export interface HoldSkip {
	key: string;
	/** `not_found`, `unchanged` (already in that state) or `lock_conflict` (changed concurrently: retry it). */
	reason: "not_found" | "unchanged" | "lock_conflict";
}

const isKeyList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((key) => typeof key === "string" && key.length > 0);

async function targetsOf(context: HoldContext, body: HoldBody): Promise<HoldTargets> {
	if ((body.keys === undefined) === (body.prefix === undefined)) return { error: "pass either keys or prefix" };
	if (body.keys !== undefined) {
		if (!isKeyList(body.keys) || body.keys.length === 0) return { error: "keys must be a non-empty list of keys" };
		if (body.keys.length > HOLD_PAGE_SIZE) return { error: `keys may list at most ${HOLD_PAGE_SIZE} keys` };
		if (body.keys.some(isReservedLockKey)) return { error: "keys may not be under a reserved prefix" };
		return { keys: [...new Set(body.keys)] };
	}
	if (typeof body.prefix !== "string" || body.prefix === "" || isReservedLockKey(body.prefix)) {
		return { error: "prefix must be a non-empty key prefix outside the reserved ones" };
	}
	const cursor = typeof body.cursor === "string" ? body.cursor : undefined;
	const listing = await context.env.MEDIA_BUCKET.list({
		prefix: storageKey(context, body.prefix),
		limit: HOLD_PAGE_SIZE,
		...(cursor ? { cursor } : {}),
	});
	const root = getRequestState(context).storagePrefix;
	// A prefix like `_` also lists the Worker's own lock records and audit objects: never touch those.
	const keys = listing.objects
		.map((object) => object.key.slice(root.length))
		.filter((key) => !isVariantKey(key) && !isReservedLockKey(key));
	return { keys, prefix: body.prefix, ...(listing.truncated ? { cursor: listing.cursor } : {}) };
}

type HoldOutcome = { updated: true } | { updated: false; reason: HoldSkip["reason"] };

async function applyHold(context: HoldContext, key: string, hold: boolean, now: Date): Promise<HoldOutcome> {
	const root = getRequestState(context).storagePrefix;
	const object = await context.env.MEDIA_BUCKET.head(storageKey(context, key));
	if (!object) return { updated: false, reason: "not_found" };
	const effective = await effectiveLock(context.env.MEDIA_BUCKET, root, key, object);
	const before: ObjectLock = effective.state?.lock ?? { hold: false };
	if ((before.hold === true) === hold) return { updated: false, reason: "unchanged" };

	const validated = validateLock({ ...before, hold });
	const after: ObjectLock = validated.ok ? validated.lock : { ...before, hold };
	const previous = effective.source === "sidecar" ? effective.stored?.sidecar : undefined;
	// The release time is what a `period` counts from from now on; while held it isn't used.
	const holdReleasedAt = hold ? previous?.holdReleasedAt : now.toISOString();
	const sidecar: LockSidecar = {
		revision: (effective.stored?.sidecar.revision ?? 0) + 1,
		objectVersion: objectVersionOf(object),
		lock: after,
		...(holdReleasedAt ? { holdReleasedAt } : {}),
		updatedAt: now.toISOString(),
	};
	const action = hold ? "hold" : "release";
	if (!(await writeSidecar(context.env.MEDIA_BUCKET, root, key, sidecar, effective.stored))) {
		await recordLockAudit(context, {
			action,
			keys: [key],
			before,
			after,
			outcome: "rejected",
			reason: "lock_conflict",
		});
		return { updated: false, reason: "lock_conflict" };
	}
	await recordLockAudit(context, { action, keys: [key], before, after, outcome: "applied" });
	return { updated: true };
}

export async function handleHold(context: HoldContext): Promise<Response> {
	const body = ((await context.req.json().catch(() => null)) ?? {}) as HoldBody;
	if (typeof body.hold !== "boolean")
		return context.json({ error: "hold must be a boolean", code: "invalid_hold" }, 400);
	const targets = await targetsOf(context, body);
	if ("error" in targets) return context.json({ error: targets.error, code: "invalid_hold" }, 400);

	const hold = body.hold;
	const decision = await decideLockChange(context, {
		action: hold ? "hold" : "release",
		keys: targets.keys,
		...(targets.prefix ? { prefix: targets.prefix } : {}),
		before: null,
		after: { hold },
	});
	if (!decision.allow) {
		await recordLockAudit(context, {
			action: hold ? "hold" : "release",
			keys: targets.keys,
			before: null,
			after: { hold },
			outcome: "rejected",
			reason: "hook_refused",
		});
		return decision.response;
	}

	const now = new Date();
	const updated: string[] = [];
	const skipped: HoldSkip[] = [];
	for (const key of targets.keys) {
		const outcome = await applyHold(context, key, hold, now);
		if (outcome.updated) updated.push(key);
		else skipped.push({ key, reason: outcome.reason });
	}
	return context.json({ updated, skipped, ...(targets.cursor ? { cursor: targets.cursor } : {}) });
}
