// Overwrite guard: a write to a key that doesn't exist yet is a create (allowed even under a locked video: new
// transcode outputs and new caption locales, decision 3 of #3); a write to an existing key is an overwrite and goes
// through `assertWritable`. The returned condition pins the write to the object the check saw, so a lock set (or an
// object written) in between makes R2 refuse the put instead of silently replacing it.
import type { Context } from "hono";
import { storageKey } from "../helpers";
import { hasPriorTranscodeOutputs } from "../transcode/raw-retention";
import type { WorkerApp } from "../types";
import { assertWritable, isReservedLockKey, reservedKeyResponse } from "./guard";
import { lockStateOf } from "./state";

type OverwriteContext = Context<WorkerApp>;

export type WriteCondition = Headers | R2Conditional;

export type WriteCheck = { blocked: Response } | { onlyIf: WriteCondition; exists: boolean };

/** `onlyIf` for a create-only put (R2 returns null if the key already exists). */
export function createOnlyCondition(): Headers {
	return new Headers({ "If-None-Match": "*" });
}

/**
 * Checks a write to the virtual `key` and returns the `onlyIf` that keeps it honest. `fullKey` is where it's stored
 * (a pending upload records it; default: under the request's storage prefix). `isLockExempt` skips the lock check
 * (an in-progress transcode job rewriting its own output, see job-outputs.ts) but keeps the condition.
 */
export async function checkWrite(
	context: OverwriteContext,
	key: string,
	fullKey = storageKey(context, key),
	options: { isLockExempt?: boolean } = {},
): Promise<WriteCheck> {
	if (isReservedLockKey(key)) return { blocked: reservedKeyResponse(context, key) };
	const object = await context.env.MEDIA_BUCKET.head(fullKey);
	if (!object) return { onlyIf: createOnlyCondition(), exists: false };
	// Still conditional: an exempt write may replace the object, but not one written since this check.
	if (options.isLockExempt) return { onlyIf: { etagMatches: object.etag }, exists: true };
	const root = fullKey.endsWith(key) ? fullKey.slice(0, fullKey.length - key.length) : undefined;
	const blocked = await assertWritable(context, [key], "overwrite", root);
	if (blocked) return { blocked };
	return { onlyIf: { etagMatches: object.etag }, exists: true };
}

/**
 * The conditional write failed: the object changed (or appeared) after the check. Not retried: the new object may be
 * locked, and a retry would need the whole request again. The client retries and gets the current answer.
 */
export function writeConflict(context: OverwriteContext, key: string): Response {
	return context.json({ error: `${key} changed while it was being written; retry`, code: "write_conflict", key }, 409);
}

/** Thrown out of a write deep in a job (a caption) when its conditional put failed. */
export class WriteConflictError extends Error {
	constructor(readonly key: string) {
		super(`${key} changed while it was being written`);
		this.name = "WriteConflictError";
	}
}

/**
 * A re-transcode overwrites the video's outputs, so it's refused while they're retained (the raw is locked with
 * `derivatives: "inherit"`). The first transcode only creates outputs and is allowed. `videoFolder` is virtual,
 * without a trailing slash (`{visibility}/video/{id}`).
 */
export async function assertRetranscodable(
	context: OverwriteContext,
	videoFolder: string,
	raw: Pick<R2Object, "customMetadata">,
): Promise<Response | null> {
	// Common case first: an unlocked raw needs no listing.
	if (!lockStateOf(raw)) return null;
	const folder = storageKey(context, `${videoFolder}/`);
	if (!(await hasPriorTranscodeOutputs(context.env.MEDIA_BUCKET, folder))) return null;
	return assertWritable(context, [videoFolder], "overwrite");
}

export type BatchWriteCheck = { blocked: Response } | { conditions: Map<string, WriteCondition> };

/**
 * Checks every virtual key a job will write before it starts (fail-fast: nothing is spent on a job whose output can't
 * be stored). Returns each key's `onlyIf`, to pass to its put.
 */
export async function checkWrites(context: OverwriteContext, keys: string[]): Promise<BatchWriteCheck> {
	const conditions = new Map<string, WriteCondition>();
	for (const key of keys) {
		const check = await checkWrite(context, key);
		if ("blocked" in check) return check;
		conditions.set(key, check.onlyIf);
	}
	return { conditions };
}
