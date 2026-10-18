// Bounded retry for runner control APIs (e.g. Fly Machines: *Create Machine* is limited to 1 req/s
// with a burst of 3 → a burst of uploads returns 429). Exponential backoff with full jitter, honoring
// `Retry-After` if the provider sends it. After exhausting attempts, returns the LAST response (or re-throws
// the last network error) so the caller fails loudly with the real detail.

export interface RetryOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	/** Injectables for tests (no real timers or randomness). */
	sleep?: (delayMs: number) => Promise<void>;
	random?: () => number;
	now?: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8000;
// An absurd Retry-After (minutes) shouldn't hang the Worker's request: it's capped.
const MAX_RETRY_AFTER_MS = 30_000;

const defaultSleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));

export function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

/** `Retry-After` in seconds (`"3"`) or an HTTP date. Null if missing or invalid. */
export function parseRetryAfterMs(header: string | null, now: number = Date.now()): number | null {
	if (!header) return null;
	const trimmed = header.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) return null;
	return Math.max(0, date - now);
}

/** Full jitter: uniform over [0, min(max, base·2^attempt)]. `attempt` starts at 0. */
export function backoffDelayMs(attempt: number, options: RetryOptions = {}): number {
	const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
	return Math.floor((options.random ?? Math.random)() * ceiling);
}

function delayFor(attempt: number, response: Response | null, options: RetryOptions): number {
	const retryAfterMs = parseRetryAfterMs(response?.headers.get("Retry-After") ?? null, (options.now ?? Date.now)());
	if (retryAfterMs !== null) return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
	return backoffDelayMs(attempt, options);
}

/**
 * Runs `send` up to `maxAttempts` times while it responds 429/5xx or the network fails. `send` is a factory
 * (a `Request` with a body can't be resent). Returns the first non-retryable response or the last one.
 */
export async function fetchWithRetry(send: () => Promise<Response>, options: RetryOptions = {}): Promise<Response> {
	const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
	const sleep = options.sleep ?? defaultSleep;

	for (let attempt = 0; ; attempt++) {
		const isLastAttempt = attempt === maxAttempts - 1;
		let response: Response;
		try {
			response = await send();
		} catch (error) {
			if (isLastAttempt) throw error;
			await sleep(delayFor(attempt, null, options));
			continue;
		}
		if (!isRetryableStatus(response.status) || isLastAttempt) return response;
		// Discard the body to free the connection before retrying.
		await response.body?.cancel();
		await sleep(delayFor(attempt, response, options));
	}
}
