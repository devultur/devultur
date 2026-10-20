// Object lock (WORM): retention and legal-style holds, resolved like the security flags
// (resource override → app default → off). Pure: no storage, no clock. The Worker enforces it.

/** `compliance`: nobody shortens or removes it. `governance`: a privileged call can. */
export type RetentionMode = "governance" | "compliance";

/** `inherit`: derived files (transcode outputs, captions) are retained too. `original-only`: only the upload. */
export type RetentionDerivatives = "inherit" | "original-only";

export interface Retention {
	mode: RetentionMode;
	/** Fixed expiry (ISO 8601 with a time zone). Mutually exclusive with `period`. */
	until?: string;
	/** Seconds from upload, or from hold release when a hold was set. Mutually exclusive with `until`. */
	period?: number;
	/** Default `inherit`. */
	derivatives?: RetentionDerivatives;
}

export interface ObjectLock {
	retention?: Retention;
	/** Retained indefinitely while true, whatever `retention` says. */
	hold?: boolean;
}

export type ResolvedRetention = Retention & { derivatives: RetentionDerivatives };

export interface ResolvedLock {
	retention?: ResolvedRetention;
	hold: boolean;
}

export type LockValidation = { ok: true; lock: ObjectLock } | { ok: false; errors: string[] };
export type LockResolution = { ok: true; lock: ResolvedLock } | { ok: false; errors: string[] };

export const RETENTION_MODES: readonly RetentionMode[] = ["governance", "compliance"];
export const RETENTION_DERIVATIVES: readonly RetentionDerivatives[] = ["inherit", "original-only"];
export const DEFAULT_RETENTION_DERIVATIVES: RetentionDerivatives = "inherit";
/** Longest `period`: 100 years, in seconds. Beyond it an expiry can't be computed as a date. */
export const MAX_RETENTION_PERIOD_SECONDS = 100 * 366 * 24 * 60 * 60;

type Raw = Record<string, unknown>;

const LOCK_FIELDS = new Set(["retention", "hold"]);
const RETENTION_FIELDS = new Set(["mode", "until", "period", "derivatives"]);
// Date, a time, and an explicit zone: a zone-less date would mean a different instant per runtime.
const ISO_8601_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const isObject = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

/** True for an ISO 8601 instant with a time zone (`2030-01-01T00:00:00Z`) that names a real date. */
export function isIsoInstant(value: unknown): value is string {
	return typeof value === "string" && ISO_8601_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

function rejectUnknownKeys(input: Raw, allowed: Set<string>, path: string, errors: string[]): void {
	for (const key of Object.keys(input)) {
		if (!allowed.has(key)) errors.push(`${path}.${key}: unknown field`);
	}
}

function validateRetention(input: unknown, path: string, errors: string[]): Retention | undefined {
	if (!isObject(input)) {
		errors.push(`${path}: must be an object`);
		return undefined;
	}
	const errorCount = errors.length;
	rejectUnknownKeys(input, RETENTION_FIELDS, path, errors);
	const { mode, until, period, derivatives } = input;
	if (!RETENTION_MODES.includes(mode as RetentionMode)) {
		errors.push(`${path}.mode: must be "governance" or "compliance"`);
	}
	if (until !== undefined && !isIsoInstant(until)) {
		errors.push(`${path}.until: must be an ISO 8601 date-time with a zone`);
	}
	const isPeriodValid =
		Number.isSafeInteger(period) && (period as number) > 0 && (period as number) <= MAX_RETENTION_PERIOD_SECONDS;
	if (period !== undefined && !isPeriodValid) {
		errors.push(`${path}.period: must be a positive integer number of seconds, at most 100 years`);
	}
	if (until !== undefined && period !== undefined) errors.push(`${path}: set either until or period, not both`);
	if (until === undefined && period === undefined) errors.push(`${path}: until or period is required`);
	if (derivatives !== undefined && !RETENTION_DERIVATIVES.includes(derivatives as RetentionDerivatives)) {
		errors.push(`${path}.derivatives: must be "inherit" or "original-only"`);
	}
	if (errors.length > errorCount) return undefined;

	const retention: Retention = { mode: mode as RetentionMode };
	if (until !== undefined) retention.until = until as string;
	if (period !== undefined) retention.period = period as number;
	if (derivatives !== undefined) retention.derivatives = derivatives as RetentionDerivatives;
	return retention;
}

/**
 * Validates an untrusted lock (request body, upload token, config). A past `until` is valid: it is
 * simply not locked any more, so an app default with a fixed date never breaks once it passes.
 */
export function validateLock(input: unknown, path = "lock"): LockValidation {
	if (!isObject(input)) return { ok: false, errors: [`${path}: must be an object`] };
	const errors: string[] = [];
	rejectUnknownKeys(input, LOCK_FIELDS, path, errors);
	const lock: ObjectLock = {};
	if (input.retention !== undefined) lock.retention = validateRetention(input.retention, `${path}.retention`, errors);
	if (input.hold !== undefined && typeof input.hold !== "boolean") errors.push(`${path}.hold: must be a boolean`);
	if (typeof input.hold === "boolean") lock.hold = input.hold;
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, lock };
}

/**
 * Resolves the effective lock: resource override → app default → off. `hold` resolves on its own.
 * `retention` resolves as a whole (its mode and expiry come from the same level, so `until` and
 * `period` never mix), except `derivatives`, which falls back to the app default and then `inherit`.
 * A resource can't drop an app default retention; it can only replace it.
 */
export function resolveLock(resource?: ObjectLock, appDefault?: ObjectLock): LockResolution {
	const errors: string[] = [];
	const resourceLock = resource === undefined ? {} : collect(validateLock(resource, "lock"), errors);
	const defaultLock = appDefault === undefined ? {} : collect(validateLock(appDefault, "default"), errors);
	if (errors.length > 0) return { ok: false, errors };

	const lock: ResolvedLock = { hold: resourceLock.hold ?? defaultLock.hold ?? false };
	const retention = resourceLock.retention ?? defaultLock.retention;
	if (!retention) return { ok: true, lock };
	const derivatives =
		resourceLock.retention?.derivatives ?? defaultLock.retention?.derivatives ?? DEFAULT_RETENTION_DERIVATIVES;
	lock.retention = { ...retention, derivatives };
	return { ok: true, lock };
}

function collect(validation: LockValidation, errors: string[]): ObjectLock {
	if (validation.ok) return validation.lock;
	errors.push(...validation.errors);
	return {};
}
