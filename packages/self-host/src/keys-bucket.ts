// Encryption at rest fails closed. `shouldEncryptAtRest` says whether a file MUST be encrypted (pure, policy + key);
// whether the Worker CAN is whether `KEYS_BUCKET` is bound. When it must but can't, the write is refused with
// `503 keys_bucket_missing` instead of storing a private file in plaintext.
import { decodeEncryptionMeta } from "@devultur/core";
import type { Context } from "hono";
import type { WorkerApp } from "./types";

export const KEYS_BUCKET_MISSING_CODE = "keys_bucket_missing";

/** Must encrypt, can't: the policy requires encryption and there's nowhere to keep the key. */
export function isKeysBucketMissing(shouldEncrypt: boolean, env: { KEYS_BUCKET?: R2Bucket }): boolean {
	return shouldEncrypt && !env.KEYS_BUCKET;
}

export function keysBucketMissing(context: Context<WorkerApp>): Response {
	console.error("[encrypt] security.encrypt is on but KEYS_BUCKET is not bound: refusing to store a private file");
	return context.json(
		{ error: "Encryption at rest is on but KEYS_BUCKET is not bound", code: KEYS_BUCKET_MISSING_CODE },
		503,
	);
}

export const ENCRYPTION_KEY_MISSING_CODE = "encryption_key_missing";

/**
 * Whether the key an upload encrypted with (`enc`) is still in the keys bucket, checked right before the object is
 * written: a delete of the object it replaces sweeps keys, and an object whose key is gone can never be decrypted.
 * `true` for a plaintext upload (no `enc`).
 */
export async function hasEncryptionKey(
	keysBucket: R2Bucket | undefined,
	objectStorageKey: string,
	enc: string | undefined,
): Promise<boolean> {
	const meta = decodeEncryptionMeta(enc);
	if (!meta) return true;
	if (!keysBucket) return false;
	return (await keysBucket.head(`${objectStorageKey}/${meta.keyId}`)) !== null;
}

export function encryptionKeyMissing(context: Context<WorkerApp>, key: string): Response {
	console.error(`[encrypt] the encryption key of ${key} is gone: refusing to store an object nobody could decrypt`);
	return context.json(
		{ error: `The encryption key of ${key} was deleted; upload it again`, code: ENCRYPTION_KEY_MISSING_CODE, key },
		500,
	);
}
