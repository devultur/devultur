// Encryption at rest fails closed. `shouldEncryptAtRest` says whether a file MUST be encrypted (pure, policy + key);
// whether the Worker CAN is whether `KEYS_BUCKET` is bound. When it must but can't, the write is refused with
// `503 keys_bucket_missing` instead of storing a private file in plaintext.
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
