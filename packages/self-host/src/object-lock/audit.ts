// Audit seam for lock events (decision 5 of #3). Records are written in a later change: one create-only object per
// event under `__lock-audit/`, a structured log line and the `onLockAudit` hook. Until then this is a no-op that the
// guard and the raw disposal already call, so wiring it in touches one file.
import type { LockOp } from "./guard";

export type LockAuditEvent =
	| { type: "write_rejected"; op: LockOp; key: string }
	| { type: "original_retained"; key: string; videoId: string };

export async function recordLockAudit(_event: LockAuditEvent): Promise<void> {}
