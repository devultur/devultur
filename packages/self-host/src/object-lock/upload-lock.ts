// The lock an upload starts with: request (`lock`, `hold`) or the upload token's pinned lock → the app default
// (`config.lock`) → off. A token's lock is a minimum the request can't loosen. A lock may outlive the file's
// `expiresAt`: retention keeps the object, expiry ends access to it (see the guide's "Retention vs expiry"). Pure: the
// caller passes the clock.
import { canChange, type ObjectLock, type ResolvedLock, resolveLock, validateLock } from "@devultur/core";
import type { UploadGrant } from "../export-types";
import type { UploadTargetError } from "../routes/upload-target";

export interface UploadLockInput {
	/** Request body fields. Untrusted: validated here. */
	lock?: unknown;
	hold?: unknown;
	grant?: UploadGrant;
	appDefault?: ObjectLock;
	/** Epoch ms of the upload request: a `period` counts from about here. */
	now: number;
}

const failure = (status: 400 | 403, code: string, error: string): UploadTargetError => ({ status, code, error });

function requestedLock(lock: unknown, hold: unknown): ObjectLock | UploadTargetError | undefined {
	if (hold !== undefined && typeof hold !== "boolean") return failure(400, "invalid_lock", "hold must be a boolean");
	if (lock === undefined && hold === undefined) return undefined;
	const validation = validateLock(lock ?? {});
	if (!validation.ok) return failure(400, "invalid_lock", validation.errors.join("; "));
	return { ...validation.lock, ...(hold !== undefined ? { hold } : {}) };
}

/** True when `lock` is at least as strict as the token's `minimum` (same rules as changing a lock, unprivileged). */
function satisfiesMinimum(minimum: ObjectLock, lock: ResolvedLock, now: number): boolean {
	if (minimum.hold && !lock.hold) return false;
	const change = canChange(minimum, lock, { privileged: false, now, timing: { uploadedAt: now } });
	return change.ok && !change.bypass;
}

/** The lock to store on the new object (`undefined`: none), or why the upload is refused. */
export function resolveUploadLock(input: UploadLockInput): ResolvedLock | undefined | UploadTargetError {
	const requested = requestedLock(input.lock, input.hold);
	if (requested && "code" in requested) return requested;
	const minimum = input.grant?.lock;
	const resolution = resolveLock(requested ?? minimum, input.appDefault);
	if (!resolution.ok) return failure(400, "invalid_lock", resolution.errors.join("; "));
	const lock = resolution.lock;
	if (minimum && !satisfiesMinimum(minimum, lock, input.now)) {
		return failure(403, "lock_below_minimum", "The upload token requires a stricter lock than the request asks for");
	}
	return lock.retention || lock.hold ? lock : undefined;
}
