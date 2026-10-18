// Upload pendings: what an authenticated `POST /v1/upload` leaves in KV for the credential-less steps that follow
// (single PUT, multipart create/part/complete/abort). A pending is keyed by a random id that only the returned upload
// URL carries (`/v1/upload/<key>?u=<id>`), never by the object key alone: keys can be predictable (an `asset/` path
// is chosen by the client), and a pending reachable by its key could be overwritten or reused by anyone who guesses
// it. The pending also records the key it was issued for, so an id only works on its own URL.
import type { Context } from "hono";
import { KvPrefix, storageKey } from "../helpers";
import { getRequestState, isAuthenticated, type PluginContext } from "../request-state";
import type { UploadPending, WorkerApp } from "../types";
import { isDerivedAssetKey } from "./derived-upload";

/** Query parameter of the upload URL that carries the pending id. */
export const UPLOAD_PENDING_QUERY = "u";

const PENDING_ID_BYTES = 16;
// 16 bytes in unpadded base64url.
const PENDING_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** New pending id: 128 random bits, base64url. */
export function newUploadPendingId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(PENDING_ID_BYTES));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** KV key of the pending with id `id`. */
export function uploadPendingKvKey(id: string): string {
	return `${KvPrefix.UPLOAD_PENDING}:${id}`;
}

/** Upload URL (path + query) for `key`, carrying the pending id. */
export function uploadUrlFor(key: string, id: string): string {
	return `/v1/upload/${key}?${UPLOAD_PENDING_QUERY}=${id}`;
}

/**
 * Pending id carried by an upload URL (absolute, or the relative URL that `POST /v1/upload` returns).
 * `undefined` = the URL carries none; `null` = it carries a malformed one. Pure.
 */
export function uploadPendingIdOf(uploadUrl: string): string | null | undefined {
	const id = new URL(uploadUrl, "http://localhost").searchParams.get(UPLOAD_PENDING_QUERY);
	if (id === null) return undefined;
	return PENDING_ID_PATTERN.test(id) ? id : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// TODO(remove after 2026-10-24): a pending written before the field rename (it lives 1 h) keeps its plugin context and
// upload metadata under the legacy field names.
function withLegacyFieldNames(pending: UploadPending & Record<string, unknown>): UploadPending {
	const { callerContext, objectMetadata, ...current } = pending;
	return {
		...current,
		...(current.context === undefined && isRecord(callerContext) ? { context: callerContext as PluginContext } : {}),
		...(current.uploadMetadata === undefined && isRecord(objectMetadata)
			? { uploadMetadata: objectMetadata as Record<string, string> }
			: {}),
	};
}

function parsePending(raw: string | null): UploadPending | null {
	if (!raw) return null;
	try {
		const pending = JSON.parse(raw) as UploadPending & Record<string, unknown>;
		return pending?.storageKey ? withLegacyFieldNames(pending) : null;
	} catch {
		return null;
	}
}

/**
 * Raw JSON of the pending that `requestUrl` points to, only if it was issued for `key`. `undefined` = the URL carries
 * no pending id; `null` = it carries one that does not resolve (malformed, unknown, expired or for another key).
 */
export async function readUploadPendingRaw(
	kv: KVNamespace,
	requestUrl: string,
	key: string,
): Promise<{ id: string; raw: string } | null | undefined> {
	const id = uploadPendingIdOf(requestUrl);
	if (id === undefined || id === null) return id;
	const raw = await kv.get(uploadPendingKvKey(id));
	const pending = parsePending(raw);
	if (!raw || !pending || pending.key !== key) return null;
	return { id, raw };
}

export interface ResolvedPending {
	pending: UploadPending;
	/** Where the pending lives in KV (to update it or delete it). */
	kvKey: string;
}

/**
 * KV key of the multipart session of a derived asset (transcode output), which has no pending id: it lives under the
 * object's full storage key, so it carries the caller's storage prefix. `null` = not a derived asset of an
 * authenticated caller.
 */
export function derivedSessionKvKey(context: Context<WorkerApp>, key: string): string | null {
	if (!isAuthenticated(context) || !isDerivedAssetKey(key)) return null;
	return `${KvPrefix.UPLOAD_PENDING}:${storageKey(context, key)}`;
}

// With a storage prefix in context (an authenticated caller), the pending must belong to it.
function isUnderCallerPrefix(context: Context<WorkerApp>, pending: UploadPending): boolean {
	const prefix = getRequestState(context).storagePrefix;
	if (!isAuthenticated(context) || !prefix) return true;
	return pending.storageKey.startsWith(prefix);
}

/**
 * Pending of a request on `/v1/upload/<key>`. `undefined` = the request names no pending (no `u` and no derived
 * session): an authenticated caller writes directly. `null` = it names one that does not resolve, or that belongs to
 * another key or storage prefix: the route answers 404 without telling which.
 */
export async function lookupUploadPending(
	context: Context<WorkerApp>,
	key: string,
): Promise<ResolvedPending | null | undefined> {
	const kv = context.env.MEDIA_KV;
	const capability = await readUploadPendingRaw(kv, context.req.url, key);
	if (capability === null) return null;
	if (capability) {
		const pending = parsePending(capability.raw);
		if (!pending || !isUnderCallerPrefix(context, pending)) return null;
		return { pending, kvKey: uploadPendingKvKey(capability.id) };
	}
	const sessionKvKey = derivedSessionKvKey(context, key);
	const session = sessionKvKey ? parsePending(await kv.get(sessionKvKey)) : null;
	return session && sessionKvKey ? { pending: session, kvKey: sessionKvKey } : undefined;
}

export const uploadNotFound = (context: Context<WorkerApp>) =>
	context.json({ error: "Upload not found or expired", code: "upload_not_found" }, 404);

/** The upload an upload URL (`/v1/upload/<key>?u=<id>`) points to, as plugins see it. */
export interface PendingUploadInfo {
	/** Key of the file (`{visibility}/…`), relative to the storage prefix. */
	key: string;
	/** Full storage key, with the storage prefix of the request that created it. */
	storageKey: string;
	contentType: string;
	filename?: string;
	/** A multipart upload was started on it. */
	isMultipart: boolean;
	/** The file expires at this time (epoch ms). */
	expiresAt?: number;
	/** An `asset/` upload that replaces the file at its path. */
	isOverwrite: boolean;
	/** Plugin context of the `POST /v1/upload` that created it. */
	context?: PluginContext;
}

function pendingUploadInfo(key: string, pending: UploadPending): PendingUploadInfo {
	return {
		key,
		storageKey: pending.storageKey,
		contentType: pending.contentType,
		...(pending.originalFilename ? { filename: pending.originalFilename } : {}),
		isMultipart: Boolean(pending.multipart),
		...(typeof pending.expiresAt === "number" ? { expiresAt: pending.expiresAt } : {}),
		isOverwrite: Boolean(pending.isAsset && pending.overwrite),
		...(pending.context ? { context: pending.context } : {}),
	};
}

const UPLOAD_URL_PREFIX = "/v1/upload/";

// biome-ignore lint/suspicious/noExplicitAny: any app that mounts the Worker (its own bindings and variables)
type AnyContext = Context<any>;

/**
 * The upload this request's upload URL points to, for a plugin that runs before the route (the route deletes it once
 * the file is complete). `undefined` = not an upload URL, or one without an id; `null` = an id that does not resolve
 * (malformed, unknown, expired or issued for another key).
 */
export async function getPendingUpload(context: AnyContext): Promise<PendingUploadInfo | null | undefined> {
	const { path } = context.req;
	if (!path.startsWith(UPLOAD_URL_PREFIX) || path.length === UPLOAD_URL_PREFIX.length) return undefined;
	const key = path.slice(UPLOAD_URL_PREFIX.length);
	const found = await readUploadPendingRaw(context.env.MEDIA_KV, context.req.url, key);
	if (!found) return found;
	const pending = parsePending(found.raw);
	return pending ? pendingUploadInfo(key, pending) : null;
}

/**
 * Cancels the upload behind an upload URL that `POST /v1/upload` returned: the URL stops working. For a plugin that
 * rejects the created upload after the route ran.
 */
export async function cancelPendingUpload(context: AnyContext, uploadUrl: string): Promise<void> {
	const id = uploadPendingIdOf(uploadUrl);
	if (id) await context.env.MEDIA_KV.delete(uploadPendingKvKey(id));
}
