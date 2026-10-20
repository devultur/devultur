// Lock checks of the upload routes (POST, single PUT, multipart create and complete), kept here so the routes only
// ask one question: may this upload write its key, and under which condition.
import { decodeEncryptionMeta, type ResolvedLock, resolveLock } from "@devultur/core";
import type { Context } from "hono";
import { storageKey } from "../helpers";
import { getRequestState } from "../request-state";
import { alreadyExists, discardStaleVariants } from "../routes/upload-integrity";
import type { UploadPending, WorkerApp } from "../types";
import { recordLockAudit } from "./audit";
import { lockSubjectOf } from "./guard";
import { isInProgressJobOutput } from "./job-outputs";
import { type AllowedWrite, checkWrite, deleteReplacedKey, writeConflict } from "./overwrite";

type UploadContext = Context<WorkerApp>;

/** `exists`: the write replaces an object (an overwrite), whose `enc` is `replacedEnc`. */
export type UploadWrite = { blocked: Response } | AllowedWrite;

/**
 * Before the bytes (and before any encryption key is created): an asset without `overwrite` must not exist yet, and an
 * existing object must not be locked. `key` is the upload's virtual key.
 */
export async function prepareUploadWrite(
	context: UploadContext,
	key: string,
	pending: Pick<UploadPending, "storageKey" | "isAsset" | "overwrite"> | null,
	fullKey: string,
): Promise<UploadWrite> {
	const isLockExempt = await isInProgressJobOutput(context, key);
	const check = await checkWrite(context, key, fullKey, { isLockExempt });
	if ("blocked" in check) return check;
	const isCreateOnly = Boolean(pending?.isAsset && !pending.overwrite);
	if (isCreateOnly && check.exists) return { blocked: alreadyExists(context, key) };
	return check;
}

/**
 * Fail-fast for an asset in `POST /v1/upload`, before the client sends bytes: without `overwrite` it must not exist;
 * with it, it must not be locked.
 */
export async function assetUploadConflict(
	context: UploadContext,
	key: string,
	fullKey: string,
	shouldOverwrite: boolean,
): Promise<Response | null> {
	const check = await checkWrite(context, key, fullKey);
	if ("blocked" in check) return check.blocked;
	return check.exists && !shouldOverwrite ? alreadyExists(context, key) : null;
}

/**
 * The conditional put failed (R2 returned null): the object appeared (`409 already_exists` for a create-only asset) or
 * changed since the check (`409 write_conflict`). The L4 key created for THIS attempt (its own keyId) protects nothing,
 * so it's deleted.
 */
export async function failedWrite(
	context: UploadContext,
	key: string,
	pending: Pick<UploadPending, "storageKey" | "isAsset" | "overwrite"> | null,
	enc: string | undefined,
): Promise<Response> {
	const meta = decodeEncryptionMeta(enc);
	const fullKey = pending?.storageKey ?? storageKey(context, key);
	if (context.env.KEYS_BUCKET && meta) await context.env.KEYS_BUCKET.delete(`${fullKey}/${meta.keyId}`);
	return pending?.isAsset && !pending.overwrite ? alreadyExists(context, key) : writeConflict(context, key);
}

/**
 * The lock a new object is stored with: the one its upload POST resolved, or, for an authenticated write with no
 * pending upload (`PUT /v1/upload/<key>` with the Worker secret), the config's default. That default only applies to
 * an original: a video's derived outputs follow their raw through `retention.derivatives` instead. An invalid default
 * fails closed (a hold), since the POST that would have reported it never ran.
 */
export function uploadLockOf(
	context: UploadContext,
	key: string,
	pending: UploadPending | null,
): ResolvedLock | undefined {
	if (pending) return pending.lock;
	if (lockSubjectOf(key)?.kind !== "original") return undefined;
	const resolution = resolveLock(undefined, getRequestState(context).config?.lock);
	if (!resolution.ok) {
		console.error("config.lock is invalid:", resolution.errors.join("; "));
		return { hold: true };
	}
	const { lock } = resolution;
	return lock.retention || lock.hold ? lock : undefined;
}

/**
 * After the bytes landed (single PUT or multipart complete):
 * - an overwrite drops the stale image variants and the replaced object's encryption key (the new object has its own);
 * - a file stored with a lock gets its first audit record (`set`, from nothing), so its protection is provable from its
 *   first write. The actor is the uploader: the POST's plugin context, since the PUT may carry no credential.
 * The replaced object's lock record stays: it's bound to that object's version, so it never applies to the new one,
 * and deleting it here could delete a record a lock change just wrote for the new object.
 */
export async function afterUploadWrite(
	context: UploadContext,
	key: string,
	pending: UploadPending | null,
	write: Pick<AllowedWrite, "exists" | "replacedEnc">,
	writtenEnc: string | undefined,
): Promise<void> {
	const fullKey = pending?.storageKey ?? storageKey(context, key);
	const root = fullKey.endsWith(key) ? fullKey.slice(0, -key.length) : getRequestState(context).storagePrefix;
	if (pending) await discardStaleVariants(context.env.MEDIA_BUCKET, pending);
	if (write.exists) await deleteReplacedKey(context, fullKey, write.replacedEnc, writtenEnc);
	const lock = uploadLockOf(context, key, pending);
	if (!lock) return;
	await recordLockAudit(context, {
		action: "set",
		keys: [key],
		before: null,
		after: lock,
		outcome: "applied",
		actor: pending ? (pending.context ?? null) : (getRequestState(context).context ?? null),
		root,
	});
}
