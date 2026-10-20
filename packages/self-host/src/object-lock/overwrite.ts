// Overwrite guard: a write to a key that doesn't exist yet is a create (allowed even under a locked video: new
// transcode outputs and new caption locales, decision 3 of #3); a write to an existing key is an overwrite and goes
// through `assertWritable`. The returned condition pins the write to the object the check saw, so a lock set (or an
// object written) in between makes R2 refuse the put instead of silently replacing it.
import { decodeEncryptionMeta, TranscodeStatus } from "@devultur/core";
import type { Context } from "hono";
import { storageKey } from "../helpers";
import { getRequestState } from "../request-state";
import { readStatus } from "../transcode/status";
import type { WorkerApp } from "../types";
import { assertWritable, isReservedLockKey, reservedKeyResponse } from "./guard";
import { effectiveLock } from "./sidecar";
import { hasCompletedTranscode } from "./transcode-marker";

type OverwriteContext = Context<WorkerApp>;

export type WriteCondition = Headers | R2Conditional;

/** `replacedEnc`: the `enc` metadata of the object an overwrite replaces (its encryption key goes once it's replaced). */
export type WriteCheck = { blocked: Response } | { onlyIf: WriteCondition; exists: boolean; replacedEnc?: string };

/**
 * `onlyIf` for a write over exactly `object`. The etag is the content's MD5, so the same bytes written again (with
 * another lock) would match it: the upload time pins that write too.
 */
function sameObject(object: Pick<R2Object, "etag"> & { uploaded?: Date }): R2Conditional {
	return {
		etagMatches: object.etag,
		// R2 keeps `uploaded` to the millisecond, so "before uploaded + 1 ms" matches exactly this write and refuses
		// any later one. Real R2 only: the in-memory bucket of the tests can't prove the precision.
		...(object.uploaded ? { uploadedBefore: new Date(object.uploaded.getTime() + 1) } : {}),
	};
}

function overwriteOf(object: R2Object): { onlyIf: WriteCondition; exists: true; replacedEnc?: string } {
	const replacedEnc = object.customMetadata?.enc;
	return { onlyIf: sameObject(object), exists: true, ...(replacedEnc ? { replacedEnc } : {}) };
}

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
	if (options.isLockExempt) return overwriteOf(object);
	const root = fullKey.endsWith(key) ? fullKey.slice(0, fullKey.length - key.length) : undefined;
	const blocked = await assertWritable(context, [key], "overwrite", root);
	if (blocked) return { blocked };
	return overwriteOf(object);
}

/**
 * After an overwrite landed: deletes the replaced object's own encryption key (`{fullKey}/{keyId}`, named by its
 * `enc`). The new object has a key of its own, and the replaced one was writable (the check allowed the overwrite), so
 * the old key protects nothing any more. Left behind, it would stay forever: a delete only knows the current `enc`.
 */
export async function deleteReplacedKey(
	context: OverwriteContext,
	fullKey: string,
	replacedEnc: string | undefined,
): Promise<void> {
	const meta = decodeEncryptionMeta(replacedEnc);
	if (!meta || !context.env.KEYS_BUCKET) return;
	await context.env.KEYS_BUCKET.delete(`${fullKey}/${meta.keyId}`);
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
 * `derivatives: "inherit"`) and a transcode of the video has completed (durable marker, or the status record).
 * Allowed: the first transcode, and the retry of one that never completed (failed, or the runner died): its partial
 * outputs were never a finished set, and the new job's runner may overwrite them (job-outputs.ts).
 */
export async function assertRetranscodable(
	context: OverwriteContext,
	video: { id: string; folder: string; rawKey: string },
	raw: Pick<R2Object, "customMetadata" | "etag"> & { uploaded?: Date },
): Promise<Response | null> {
	const root = getRequestState(context).storagePrefix;
	const { state } = await effectiveLock(context.env.MEDIA_BUCKET, root, video.rawKey, raw);
	if (!state) return null;
	const isCompleted =
		(await hasCompletedTranscode(context.env.MEDIA_BUCKET, root, video.folder)) ||
		(await readStatus(context.env.MEDIA_KV, video.id))?.status === TranscodeStatus.COMPLETED;
	if (!isCompleted) return null;
	return assertWritable(context, [video.folder], "overwrite");
}

export type AllowedWrite = Exclude<WriteCheck, { blocked: Response }>;

export type BatchWriteCheck = { blocked: Response } | { checks: Map<string, AllowedWrite> };

/**
 * Checks every virtual key a job will write before it starts (fail-fast: nothing is spent on a job whose output can't
 * be stored). Returns each key's check: the `onlyIf` to pass to its put, and what it replaces.
 */
export async function checkWrites(context: OverwriteContext, keys: string[]): Promise<BatchWriteCheck> {
	const checks = new Map<string, AllowedWrite>();
	for (const key of keys) {
		const check = await checkWrite(context, key);
		if ("blocked" in check) return check;
		checks.set(key, check);
	}
	return { checks };
}
