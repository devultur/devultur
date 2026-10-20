// Object lock client of a media worker: read and change an object's retention (`/v1/lock/:key`) and set or release
// holds (`/v1/lock/hold`). Refusals surface as `DevulturApiError` with the worker's `code` and `details`:
// `retention_active` (409, `details: { key, mode, until, hold }`), `compliance_extend_only` (409), `lock_conflict`
// (409, retry), `lock_privilege_required` (403), `invalid_lock` / `reserved_key` (400).
import type { RetentionDerivatives, RetentionMode } from "./lock";

/** The lock in force on an object. */
export interface LockView {
	key: string;
	mode: RetentionMode | null;
	/** Effective expiry (ISO): a fixed `until`, or a `period` from upload (or from the hold's release). */
	until: string | null;
	period: number | null;
	hold: boolean;
	derivatives: RetentionDerivatives | null;
	/** `upload`: set when the file was uploaded. `sidecar`: changed since. `none`: not locked. */
	source: "sidecar" | "upload" | "none";
	/** Number of changes since upload (`null` while the upload lock is in force). */
	revision: number | null;
}

/** A retention change. Fields merge over the current retention; `until` and `period` replace each other. */
export interface SetLockOptions {
	mode?: RetentionMode;
	until?: string;
	period?: number;
	derivatives?: RetentionDerivatives;
	/** Drop the retention (governance only, with `bypassGovernance`). */
	remove?: true;
	/** Shorten or remove a governance retention: the worker's `authorizeLockChange` hook must approve it. */
	bypassGovernance?: boolean;
}

/** What a hold request names: a list of keys (at most {@link HOLD_PAGE_SIZE} per call), or every key under a prefix. */
export type HoldTarget = string[] | { prefix: string };

export interface HoldSkip {
	key: string;
	/** `not_found`, `unchanged` (already in that state) or `lock_conflict` (changed concurrently: retry it). */
	reason: "not_found" | "unchanged" | "lock_conflict";
}

export interface HoldPage {
	updated: string[];
	skipped: HoldSkip[];
	/** More objects under the prefix: pass it back to get the next page. */
	cursor?: string;
}

/** Objects the worker changes per hold request (keys per call, and objects per prefix page). */
export const HOLD_PAGE_SIZE = 50;

export interface LockClient {
	get(key: string): Promise<LockView>;
	set(key: string, options: SetLockOptions): Promise<LockView>;
	/** One page: up to {@link HOLD_PAGE_SIZE} keys, or one page of a prefix (`cursor` for the next). */
	hold(target: HoldTarget, options?: { cursor?: string }): Promise<HoldPage>;
	release(target: HoldTarget, options?: { cursor?: string }): Promise<HoldPage>;
	/** Every page: a long key list in chunks, or a prefix following its cursor. */
	holdAll(target: HoldTarget): AsyncGenerator<HoldPage>;
	releaseAll(target: HoldTarget): AsyncGenerator<HoldPage>;
}

type JsonRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

function chunks(keys: string[]): string[][] {
	const pages: string[][] = [];
	for (let start = 0; start < keys.length; start += HOLD_PAGE_SIZE)
		pages.push(keys.slice(start, start + HOLD_PAGE_SIZE));
	return pages;
}

export function createLockClient(request: JsonRequest): LockClient {
	const page = (hold: boolean, target: HoldTarget, cursor?: string) =>
		request<HoldPage>("/v1/lock/hold", {
			method: "POST",
			body: JSON.stringify({
				hold,
				...(Array.isArray(target) ? { keys: target } : { prefix: target.prefix }),
				...(cursor ? { cursor } : {}),
			}),
		});

	async function* every(hold: boolean, target: HoldTarget): AsyncGenerator<HoldPage> {
		if (Array.isArray(target)) {
			for (const keys of chunks(target)) yield page(hold, keys);
			return;
		}
		let cursor: string | undefined;
		do {
			const result = await page(hold, target, cursor);
			yield result;
			cursor = result.cursor;
		} while (cursor);
	}

	return {
		get: (key) => request<LockView>(`/v1/lock/${encodeKey(key)}`),
		set: (key, options) =>
			request<LockView>(`/v1/lock/${encodeKey(key)}`, { method: "PUT", body: JSON.stringify(options) }),
		hold: (target, options) => page(true, target, options?.cursor),
		release: (target, options) => page(false, target, options?.cursor),
		holdAll: (target) => every(true, target),
		releaseAll: (target) => every(false, target),
	};
}
