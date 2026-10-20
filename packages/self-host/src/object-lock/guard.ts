// Delete/overwrite guard for locked objects (#3, #4). Every route that deletes or replaces stored bytes asks
// `assertWritable` first; the bulk helpers below run it for you, so a caller can't sweep a prefix or an object's
// encryption keys without the check. R2 deletes aren't conditional: a lock set between the check and the delete
// (milliseconds) isn't seen. That window is accepted (decision 2).
import { decodeEncryptionMeta, effectiveUntil, isVideoRawKey, type RetentionDerivatives } from "@devultur/core";
import type { Context, MiddlewareHandler } from "hono";
import { deletePrefix, storageKey } from "../helpers";
import { isVariantKey, variantPrefix } from "../image/transform-plan";
import { getRequestState } from "../request-state";
import type { WorkerApp } from "../types";
import { recordLockAudit } from "./audit";
import { effectiveLock } from "./sidecar";
import { isStateLocked, type LockState } from "./state";

type GuardContext = Context<WorkerApp>;

export type LockOp = "delete" | "overwrite";

/** Prefixes the Worker keeps for lock sidecars and audit records: no route reads or writes a key under them. */
export const RESERVED_LOCK_PREFIXES = ["__lock/", "__lock-audit/"] as const;

export function isReservedLockKey(key: string): boolean {
	const normalized = `${key.replace(/^\/+/, "")}/`;
	return RESERVED_LOCK_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function reservedKeyResponse(context: GuardContext, key: string): Response {
	return context.json({ error: `${key} is under a reserved prefix`, code: "reserved_key", key }, 400);
}

/** The key part of a route path (`/v1/{route}/{key}`), decoded. */
function routeKeyOf(path: string): string {
	const key = path.split("/").slice(3).join("/");
	try {
		return decodeURIComponent(key);
	} catch {
		return key;
	}
}

/** Rejects any `/v1/{route}/{key}` request whose key is under a reserved lock prefix, whatever the method. */
export const rejectReservedLockPaths: MiddlewareHandler<WorkerApp> = async (context, next) => {
	const key = routeKeyOf(context.req.path);
	if (isReservedLockKey(key)) return reservedKeyResponse(context, key);
	await next();
};

const VIDEO_KEY = /^((?:public|private)\/video\/[^/]+)(?:\/|$)/;

/**
 * Which stored original decides whether `key` can change: the key itself, the raws of its video (a derived file under
 * the video folder, or the folder itself), or nothing (image variants and mezzanines are regenerable caches).
 */
type LockSubject = { kind: "original"; key: string } | { kind: "video"; rawPrefix: string } | null;

export function lockSubjectOf(key: string): LockSubject {
	if (isVariantKey(key)) return null;
	if (isVideoRawKey(key)) return { kind: "original", key };
	const video = VIDEO_KEY.exec(key);
	if (video) return { kind: "video", rawPrefix: `${video[1]}/raw/` };
	return { kind: "original", key };
}

interface LockedOriginal {
	key: string;
	state: LockState;
}

/** With `original-only`, derived files are free: only the uploaded object is retained. */
function protectsDerived(state: LockState): boolean {
	const derivatives: RetentionDerivatives = state.lock.retention?.derivatives ?? "inherit";
	return derivatives === "inherit";
}

async function lockedOriginal(
	context: GuardContext,
	root: string,
	key: string,
	now: Date,
): Promise<LockedOriginal | null> {
	const object = await context.env.MEDIA_BUCKET.head(`${root}${key}`);
	const state = object ? (await effectiveLock(context.env.MEDIA_BUCKET, root, key, object)).state : null;
	return state && isStateLocked(state, now) ? { key, state } : null;
}

// Heads each raw instead of trusting the listing's metadata (a list only carries it with `include`, per compat date).
async function lockedRaw(
	context: GuardContext,
	root: string,
	rawPrefix: string,
	now: Date,
): Promise<LockedOriginal | null> {
	let cursor: string | undefined;
	do {
		const listing = await context.env.MEDIA_BUCKET.list({ prefix: `${root}${rawPrefix}`, cursor });
		for (const listed of listing.objects) {
			const key = listed.key.slice(root.length);
			const object = await context.env.MEDIA_BUCKET.head(listed.key);
			const state = object ? (await effectiveLock(context.env.MEDIA_BUCKET, root, key, object)).state : null;
			if (state && protectsDerived(state) && isStateLocked(state, now)) return { key, state };
		}
		cursor = listing.truncated ? listing.cursor : undefined;
	} while (cursor);
	return null;
}

function retentionActive(context: GuardContext, locked: LockedOriginal, op: LockOp): Response {
	const { lock, uploadedAt, holdReleasedAt } = locked.state;
	let until: string | undefined;
	try {
		until = effectiveUntil(lock, { uploadedAt, holdReleasedAt });
	} catch {}
	const verb = op === "delete" ? "deleted" : "overwritten";
	return context.json(
		{
			error: `${locked.key} is retained and can't be ${verb}`,
			code: "retention_active",
			key: locked.key,
			...(lock.retention ? { mode: lock.retention.mode } : {}),
			...(until ? { until } : {}),
			hold: lock.hold === true,
		},
		409,
	);
}

/**
 * `null` when every key (virtual, without the storage prefix) may be deleted or overwritten; otherwise the response to
 * send: `400 reserved_key`, or `409 retention_active` naming the locked original. All-or-nothing: check every key of a
 * bulk operation here before deleting any. `root` is the storage prefix the keys live under: the request's by default,
 * or the one a pending upload recorded (a credential-less PUT has none of its own).
 */
export async function assertWritable(
	context: GuardContext,
	keys: string[],
	op: LockOp,
	root = getRequestState(context).storagePrefix,
): Promise<Response | null> {
	const reserved = keys.find(isReservedLockKey);
	if (reserved !== undefined) return reservedKeyResponse(context, reserved);

	const now = new Date();
	const checked = new Set<string>();
	for (const key of keys) {
		const subject = lockSubjectOf(key);
		if (!subject) continue;
		const subjectId = subject.kind === "original" ? subject.key : subject.rawPrefix;
		if (checked.has(subjectId)) continue;
		checked.add(subjectId);
		const locked =
			subject.kind === "original"
				? await lockedOriginal(context, root, subject.key, now)
				: await lockedRaw(context, root, subject.rawPrefix, now);
		if (!locked) continue;
		const requested = key === locked.key ? [key] : [key, locked.key];
		await recordLockAudit(context, {
			action: op === "delete" ? "delete_rejected" : "overwrite_rejected",
			keys: requested,
			before: locked.state.lock,
			after: null,
			outcome: "rejected",
			reason: "retention_active",
			root,
		});
		return retentionActive(context, locked, op);
	}
	return null;
}

export type GuardedDelete = { blocked: Response } | { deletedCount: number };

/** R2 deletes up to 1000 keys per call. */
const DELETE_BATCH_SIZE = 1000;

/**
 * Lists every media object under the virtual `prefix`, checks them all, then deletes exactly those (or none). Use it
 * instead of `deletePrefix`, which bypasses locks.
 */
export async function guardedDeletePrefix(context: GuardContext, prefix: string): Promise<GuardedDelete> {
	const root = getRequestState(context).storagePrefix;
	const storageKeys: string[] = [];
	let cursor: string | undefined;
	do {
		const listing = await context.env.MEDIA_BUCKET.list({ prefix: storageKey(context, prefix), cursor });
		storageKeys.push(...listing.objects.map((object) => object.key));
		cursor = listing.truncated ? listing.cursor : undefined;
	} while (cursor);
	const keys = storageKeys.map((key) => key.slice(root.length));
	const blocked = await assertWritable(context, keys, "delete");
	if (blocked) return { blocked };
	for (let start = 0; start < storageKeys.length; start += DELETE_BATCH_SIZE) {
		await context.env.MEDIA_BUCKET.delete(storageKeys.slice(start, start + DELETE_BATCH_SIZE));
	}
	// The lock records of what was deleted stay, inert (bound to the deleted versions): deleting them could delete a
	// record a lock change just wrote for a file uploaded again at one of these keys.
	return { deletedCount: storageKeys.length };
}

/**
 * The object's own keys in the keys bucket: the direct children of `{storageKey}/` (`{storageKey}/{keyId}`; a key id
 * has no `/`). The current `enc`'s and any a replaced version left behind. Never deeper: an asset nested under this
 * one's path (`asset/a` and `asset/a/b.pdf` are both valid) keeps its keys at `{storageKey}/b.pdf/{keyId}`.
 */
async function ownKeysOf(keysBucket: R2Bucket, fullKey: string): Promise<R2Object[]> {
	const keys: R2Object[] = [];
	let cursor: string | undefined;
	do {
		const listing = await keysBucket.list({ prefix: `${fullKey}/`, delimiter: "/", cursor });
		keys.push(...listing.objects);
		cursor = listing.truncated ? listing.cursor : undefined;
	} while (cursor);
	return keys;
}

/** The deleted object's version, read (HEAD) before its delete: its `enc` and when it was written. */
export type DeletedVersion = Pick<R2Object, "uploaded" | "customMetadata">;

/**
 * Whether a key under the object's prefix belongs to the deleted version or one it replaced: written no later than the
 * deleted object. A newer key is an upload in flight (a multipart created over it, a PUT between its key and its put):
 * shredding it would leave that upload's object undecryptable.
 */
function isKeyOfDeletedVersion(key: R2Object, deleted: DeletedVersion): boolean {
	return key.uploaded.getTime() <= deleted.uploaded.getTime();
}

/**
 * Deletes one object's encryption material from the keys bucket: its own keys (`{storageKey}/{keyId}`, see
 * `ownKeysOf`) no newer than the deleted version, and its variants' (`{storageKey}/__variants/…`). Never a bare
 * `{storageKey}/` prefix: the keys of an asset nested under this one's path live there. Destroying the keys destroys
 * the object (crypto-shredding), so the object must be writable.
 */
export async function deleteKeysFor(
	context: GuardContext,
	objectKey: string,
	deleted: DeletedVersion,
): Promise<GuardedDelete> {
	const blocked = await assertWritable(context, [objectKey], "delete");
	if (blocked) return { blocked };
	const keysBucket = context.env.KEYS_BUCKET;
	if (!keysBucket) return { deletedCount: 0 };
	const fullKey = storageKey(context, objectKey);
	const ownKeys = new Set(
		(await ownKeysOf(keysBucket, fullKey)).filter((key) => isKeyOfDeletedVersion(key, deleted)).map((key) => key.key),
	);
	const meta = decodeEncryptionMeta(deleted.customMetadata?.enc);
	if (meta) ownKeys.add(`${fullKey}/${meta.keyId}`);
	if (ownKeys.size > 0) await keysBucket.delete([...ownKeys]);
	const variantKeyCount = await deletePrefix(keysBucket, variantPrefix(fullKey));
	return { deletedCount: variantKeyCount + ownKeys.size };
}

/** Deletes every key of a video folder (virtual `{visibility}/video/{id}`): all of it belongs to that one video. */
export async function deleteFolderKeys(context: GuardContext, videoFolder: string): Promise<GuardedDelete> {
	const blocked = await assertWritable(context, [videoFolder], "delete");
	if (blocked) return { blocked };
	if (!context.env.KEYS_BUCKET) return { deletedCount: 0 };
	return { deletedCount: await deletePrefix(context.env.KEYS_BUCKET, `${storageKey(context, videoFolder)}/`) };
}
