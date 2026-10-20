// Upload integrity and TTL: the plaintext's sha256 (before L4 encryption), the metadata that carries it onto the R2
// object, and the error responses shared by the single PUT, multipart, and the creation POST.
import { normalizeSha256, type ResolvedLock, SHA256_HEADER, sha256Hex } from "@devultur/core";
import type { Context } from "hono";
import { deletePrefix } from "../helpers";
import { variantPrefix } from "../image/transform-plan";
import { encodeLockMetadata, LOCK_METADATA_KEY } from "../object-lock/state";
import type { WorkerApp } from "../types";
import type { UploadTargetError } from "./upload-target";

type UploadContext = Context<WorkerApp>;

/** `customMetadata` keys on the R2 object (strings). */
export const ObjectMeta = {
	SHA256: "sha256",
	/** `"true"` = the worker hashed the bytes; `"false"` = sha256 declared by the client (multipart). */
	SHA256_VERIFIED: "sha256Verified",
	/** Epoch ms. From then on the gate responds 410 (and an external sweeper may delete it). */
	EXPIRES_AT: "expiresAt",
} as const;

/**
 * `customMetadata` keys the Worker itself writes and reads (besides `sha256*`): security policy,
 * encryption material, expiry, the marker for image variants, and the object lock. Lowercase (R2's S3-based keys are
 * case-insensitive).
 */
const WORKER_METADATA_KEYS = new Set([
	"security",
	"enc",
	ObjectMeta.EXPIRES_AT.toLowerCase(),
	"derivedfrom",
	LOCK_METADATA_KEY,
]);

function isWorkerMetadataKey(key: string): boolean {
	const lowerKey = key.toLowerCase();
	return lowerKey.startsWith(ObjectMeta.SHA256) || WORKER_METADATA_KEYS.has(lowerKey);
}

/**
 * `config.uploadMetadata` without the keys the Worker owns: a plugin can't set an object's policy, encryption, expiry or
 * integrity, even when the Worker doesn't write that key on this upload.
 */
export function allowedUploadMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
	if (!metadata) return {};
	return Object.fromEntries(Object.entries(metadata).filter(([key]) => !isWorkerMetadataKey(key)));
}

export function targetFailure(context: UploadContext, failure: UploadTargetError): Response {
	return context.json({ error: failure.error, code: failure.code }, failure.status);
}

export function alreadyExists(context: UploadContext, key: string): Response {
	return context.json(
		{ error: `${key} already exists; pass overwrite: true to replace it`, code: "already_exists", key },
		409,
	);
}

export function sha256Mismatch(context: UploadContext, expected: string, actual: string): Response {
	return context.json(
		{ error: "The uploaded bytes do not match the declared sha256", code: "sha256_mismatch", expected, actual },
		400,
	);
}

/** sha256 the request declares in the header (`x-devultur-sha256`). `null` if it came in invalid. */
export function headerSha256(context: UploadContext): string | undefined | null {
	const raw = context.req.header(SHA256_HEADER);
	if (raw === undefined) return undefined;
	return normalizeSha256(raw);
}

export type BodyDigest = { sha256: string } | { mismatch: { expected: string; actual: string } } | { invalid: true };

/** Hashes the body (plaintext) and compares it against what was declared (pending or header). */
export async function digestBody(
	body: ArrayBuffer,
	declared: string | undefined,
	header: string | undefined | null,
): Promise<BodyDigest> {
	if (header === null) return { invalid: true };
	const actual = await sha256Hex(body);
	const expected = declared ?? header;
	if (expected && expected !== actual) return { mismatch: { expected, actual } };
	return { sha256: actual };
}

/** The lock metadata for the object (`{}` when it isn't locked). */
export function lockMetadata(lock: ResolvedLock | undefined): Record<string, string> {
	const encoded = encodeLockMetadata(lock);
	return encoded ? { [LOCK_METADATA_KEY]: encoded } : {};
}

/** Integrity/TTL metadata for the object. */
export function integrityMetadata(
	sha256: string | undefined,
	isVerified: boolean,
	expiresAt: number | undefined,
): Record<string, string> {
	return {
		...(sha256 ? { [ObjectMeta.SHA256]: sha256, [ObjectMeta.SHA256_VERIFIED]: String(isVerified) } : {}),
		...(expiresAt ? { [ObjectMeta.EXPIRES_AT]: String(expiresAt) } : {}),
	};
}

/**
 * An overwrite changes the original's bytes: its image variants (`{storageKey}/__variants/`, generated from the
 * old bytes) stop being valid and get regenerated on the next request.
 */
export async function discardStaleVariants(
	bucket: R2Bucket,
	pending: { storageKey: string; overwrite?: boolean } | null,
): Promise<void> {
	if (!pending?.overwrite) return;
	await deletePrefix(bucket, variantPrefix(pending.storageKey));
}
