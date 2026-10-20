import type { MockInstance } from "vitest";
import type { LockAuditRecord } from "./audit";

/** The audit records a `console.log` spy saw (the structured `lock.audit` lines, not the request log). */
export function loggedAudits(log: MockInstance): LockAuditRecord[] {
	return log.mock.calls
		.map(([line]) => String(line))
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line) as { event?: string } & LockAuditRecord)
		.filter((line) => line.event === "lock.audit");
}
