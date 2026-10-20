// `GET|PUT /v1/lock/:key`: read and change an object's retention; `POST /v1/lock/hold`: set or release holds (hold.ts).
// Control routes: the default auth only lets the Worker secret through, and the route itself refuses anything not
// authenticated.
import { canChange, effectiveUntil, type ObjectLock } from "@devultur/core";
import { type Context, Hono } from "hono";
import { storageKey } from "../helpers";
import { decideLockChange } from "../plugin-hooks";
import { getRequestState, isAuthenticated } from "../request-state";
import type { WorkerApp } from "../types";
import { recordLockAudit } from "./audit";
import { classifyChange, type LockChangeBody, nextLock, timingOf } from "./change";
import { handleHold } from "./hold";
import {
	type EffectiveLock,
	effectiveLock,
	type LockSidecar,
	objectVersionOf,
	unreadableLockRefusal,
	writeSidecar,
} from "./sidecar";
import type { LockState } from "./state";

type LockContext = Context<WorkerApp>;

function lockView(key: string, effective: Pick<EffectiveLock, "state" | "source" | "stored">) {
	const lock = effective.state?.lock;
	let until: string | undefined;
	try {
		until = lock ? effectiveUntil(lock, timingOf(effective.state)) : undefined;
	} catch {}
	return {
		key,
		mode: lock?.retention?.mode ?? null,
		until: until ?? null,
		period: lock?.retention?.period ?? null,
		hold: lock?.hold === true,
		derivatives: lock?.retention ? (lock.retention.derivatives ?? "inherit") : null,
		source: effective.source,
		revision: effective.source === "sidecar" ? (effective.stored?.sidecar.revision ?? null) : null,
	};
}

async function loadTarget(context: LockContext) {
	const key = context.req.param("key") ?? "";
	const root = getRequestState(context).storagePrefix;
	const object = await context.env.MEDIA_BUCKET.head(storageKey(context, key));
	if (!object) return { key, root, object: null, effective: null };
	return { key, root, object, effective: await effectiveLock(context.env.MEDIA_BUCKET, root, key, object) };
}

const lockRoute = new Hono<WorkerApp>();

lockRoute.use("*", async (context, next) => {
	if (!isAuthenticated(context)) return context.json({ error: "Unauthorized" }, 401);
	await next();
});

lockRoute.post("/hold", handleHold);

lockRoute.get("/:key{.+}", async (context) => {
	const { key, effective } = await loadTarget(context);
	if (!effective) return context.json({ error: "Not found" }, 404);
	return context.json(lockView(key, effective));
});

lockRoute.put("/:key{.+}", async (context) => {
	const body = ((await context.req.json().catch(() => null)) ?? {}) as LockChangeBody;
	const { key, root, object, effective } = await loadTarget(context);
	if (!object || !effective) return context.json({ error: "Not found" }, 404);
	const before = effective.state?.lock ?? null;
	const next = nextLock(before, body);
	if (!next.ok) return context.json({ error: next.errors.join("; "), code: "invalid_lock" }, 400);

	const now = new Date();
	const action = classifyChange(effective.state, next.lock, now);
	const audit = { action, keys: [key], before, after: next.lock, root };
	const unreadable = unreadableLockRefusal(effective.state, key);
	if (unreadable) {
		await recordLockAudit(context, { ...audit, outcome: "rejected", reason: "lock_record_unreadable" });
		return unreadable;
	}
	const decision = await decideLockChange(context, { action, keys: [key], before, after: next.lock });
	if (!decision.allow) {
		await recordLockAudit(context, { ...audit, outcome: "rejected", reason: "hook_refused" });
		return decision.response;
	}
	const isPrivileged = body.bypassGovernance === true && decision.isApproved;
	const change = canChange(before ?? {}, next.lock, {
		privileged: isPrivileged,
		now,
		timing: timingOf(effective.state),
	});
	if (!change.ok) {
		await recordLockAudit(context, { ...audit, outcome: "rejected", reason: change.reason });
		return refusal(context, key, change.reason);
	}

	const sidecar = nextSidecar(effective, objectVersionOf(object), next.lock, now);
	if (!(await writeSidecar(context.env.MEDIA_BUCKET, root, key, sidecar, effective.stored))) {
		await recordLockAudit(context, { ...audit, outcome: "rejected", reason: "lock_conflict" });
		return context.json({ error: `The lock of ${key} changed meanwhile; retry`, code: "lock_conflict", key }, 409);
	}
	await recordLockAudit(context, { ...audit, outcome: "applied", ...(change.bypass ? { bypass: true } : {}) });
	const state: LockState = { ...(effective.state ?? {}), lock: next.lock };
	return context.json(lockView(key, { state, source: "sidecar", stored: { sidecar, etag: "" } }));
});

function nextSidecar(effective: EffectiveLock, objectVersion: string, lock: ObjectLock, now: Date): LockSidecar {
	const previous = effective.source === "sidecar" ? effective.stored?.sidecar : undefined;
	return {
		revision: (effective.stored?.sidecar.revision ?? 0) + 1,
		objectVersion,
		lock,
		...(previous?.holdReleasedAt ? { holdReleasedAt: previous.holdReleasedAt } : {}),
		updatedAt: now.toISOString(),
	};
}

function refusal(context: LockContext, key: string, reason: "compliance_extend_only" | "lock_privilege_required") {
	if (reason === "lock_privilege_required") {
		return context.json(
			{
				error:
					"Shortening or removing a governance retention needs bypassGovernance and an authorizeLockChange approval",
				code: reason,
				key,
			},
			403,
		);
	}
	return context.json({ error: `The compliance retention of ${key} can only be extended`, code: reason, key }, 409);
}

export { lockRoute };
