// Lock audit (decision 5 of #3): every lock change and every rejected delete or overwrite becomes one record. Each
// record goes to a structured log line, to one create-only object at `{storagePrefix}__lock-audit/{yyyy-mm-dd}/
// {ts}-{uuid}.json` in the media bucket, and to every plugin's `onLockAudit` hook (to store it elsewhere). The object
// and the hooks run after the response (`waitUntil`); a failure there is logged, never surfaced to the caller.
import type { ObjectLock } from "@devultur/core";
import type { Context } from "hono";
import { getPluginHooks } from "../plugin-hooks";
import { getRequestState, type PluginContext } from "../request-state";
import type { WorkerApp } from "../types";

export const LOCK_AUDIT_PREFIX = "__lock-audit/";

export type LockAuditAction =
	| "set"
	| "extend"
	| "shorten"
	| "remove"
	| "delete_rejected"
	| "overwrite_rejected"
	| "original_retained";

export interface LockAuditRecord {
	/** ISO time of the event. */
	at: string;
	action: LockAuditAction;
	/** Virtual keys the event is about. */
	keys: string[];
	before: ObjectLock | null;
	after: ObjectLock | null;
	/** The request's plugin context (who the auth layer said is calling), or null. */
	actor: PluginContext | null;
	/** `applied`: the change landed. `rejected`: the Worker refused it. `skipped`: a delete didn't run (retained raw). */
	outcome: "applied" | "rejected" | "skipped";
	/** The change used the governance privilege (`bypassGovernance` approved by `authorizeLockChange`). */
	bypass?: boolean;
	/** Why it was rejected (a response code). */
	reason?: string;
}

export type LockAuditInput = Omit<LockAuditRecord, "at" | "actor"> & {
	/** Storage prefix the keys live under. Default: the request's (a webhook has none of its own). */
	root?: string;
};

type AuditContext = Context<WorkerApp>;

/** Where a record is stored: by UTC day, then by time, so a listing reads in order. */
export function auditObjectKey(root: string, at: Date, id: string = crypto.randomUUID()): string {
	return `${root}${LOCK_AUDIT_PREFIX}${at.toISOString().slice(0, 10)}/${at.getTime()}-${id}.json`;
}

async function deliver(context: AuditContext, root: string, record: LockAuditRecord): Promise<void> {
	const body = JSON.stringify(record);
	const stored = context.env.MEDIA_BUCKET.put(auditObjectKey(root, new Date(record.at)), body, {
		onlyIf: new Headers({ "If-None-Match": "*" }),
		httpMetadata: { contentType: "application/json" },
	});
	const hooks = getPluginHooks(context).onLockAudit.map((hook) => hook(context, record));
	const results = await Promise.allSettled([stored, ...hooks]);
	for (const result of results) {
		if (result.status === "rejected") console.error("lock audit delivery failed:", result.reason);
	}
}

/** Runs `task` after the response when the runtime allows it; otherwise (no execution context) waits for it. */
async function inBackground(context: AuditContext, task: Promise<void>): Promise<void> {
	let executionCtx: { waitUntil: (task: Promise<unknown>) => void } | undefined;
	try {
		executionCtx = context.executionCtx;
	} catch {}
	if (!executionCtx) return task;
	executionCtx.waitUntil(task);
}

export async function recordLockAudit(context: AuditContext, input: LockAuditInput): Promise<void> {
	const { root = getRequestState(context).storagePrefix, ...event } = input;
	const record: LockAuditRecord = {
		at: new Date().toISOString(),
		...event,
		actor: getRequestState(context).context ?? null,
	};
	console.log(JSON.stringify({ event: "lock.audit", ...record }));
	await inBackground(context, deliver(context, root, record));
}
