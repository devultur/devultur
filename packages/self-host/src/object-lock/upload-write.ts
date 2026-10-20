// Lock checks of the upload routes (POST, single PUT, multipart create and complete), kept here so the routes only
// ask one question: may this upload write its key, and under which condition.
import { decodeEncryptionMeta } from "@devultur/core";
import type { Context } from "hono";
import { storageKey } from "../helpers";
import { alreadyExists } from "../routes/upload-integrity";
import type { UploadPending, WorkerApp } from "../types";
import { checkWrite, type WriteCondition, writeConflict } from "./overwrite";

type UploadContext = Context<WorkerApp>;

export type UploadWrite = { blocked: Response } | { onlyIf: WriteCondition };

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
	const check = await checkWrite(context, key, fullKey);
	if ("blocked" in check) return check;
	const isCreateOnly = Boolean(pending?.isAsset && !pending.overwrite);
	if (isCreateOnly && check.exists) return { blocked: alreadyExists(context, key) };
	return { onlyIf: check.onlyIf };
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
