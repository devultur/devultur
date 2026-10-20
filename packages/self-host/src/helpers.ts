import { type SecurityPolicy, visibilityFromKey } from "@devultur/core";
import type { Context } from "hono";
import { isBearerAuthorized } from "./bearer";
import { withCurrentClaimNames } from "./legacy-claims";
import { getRequestState } from "./request-state";
import type { WorkerApp } from "./types";
import { HashAlgorithm } from "./types";

/**
 * Header an internal upload (the transcode) uses to propagate the resource's security override to the
 * derived assets (segments/playlist/thumbnail) so the gate binds them per-resource just like the raw.
 */
export const RESOURCE_SECURITY_HEADER = "X-Devultur-Resource-Security";

/** Parses the security override from a header (JSON). Undefined if missing or invalid. */
export function parseSecurityHeader(raw: string | undefined): SecurityPolicy | undefined {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as SecurityPolicy;
	} catch {
		return undefined;
	}
}

/**
 * Is `contentType` allowed by the `accept` whitelist? Supports exact entries (`image/png`) and
 * family wildcards (`image/*`). Empty/absent list = allows everything. Pure → testable. It's a guardrail
 * over the declared content-type (no byte sniffing): it trusts that the consumer uploads what it says.
 */
export function isContentTypeAllowed(contentType: string, accept: string[] | undefined): boolean {
	if (!accept || accept.length === 0) return true;
	const type = contentType.toLowerCase().split(";")[0].trim();
	return accept.some((entry) => {
		const rule = entry.toLowerCase().trim();
		if (rule === "*" || rule === "*/*") return true; // explicit "allow everything"
		if (rule.endsWith("/*")) return type.startsWith(`${rule.slice(0, -1)}`);
		return type === rule;
	});
}

/** Are all the requested locales in the whitelist? Empty/absent allowed list = allows everything.
 *  Pure → testable. */
export function areLocalesAllowed(requested: string[], allowed: string[] | undefined): boolean {
	if (!allowed || allowed.length === 0) return true;
	const allowedSet = new Set(allowed.map((locale) => locale.toLowerCase()));
	return requested.every((locale) => allowedSet.has(locale.toLowerCase()));
}

export function storageKey(context: Context<WorkerApp>, key: string): string {
	return `${getRequestState(context).storagePrefix}${key}`;
}

export function storagePrefix(context: Context<WorkerApp>, prefix: string): string {
	return `${getRequestState(context).storagePrefix}${prefix}`;
}

/**
 * Auth gate for the transcode callback (`/v1/webhooks/transcode`). The transcode script sends
 * `Authorization: Bearer <secret>`. Fail-closed: with no secret configured nobody is authorized (the route
 * answers 503 first). Constant-time compare. Pure so it can be unit-tested without a worker context.
 */
export function isTranscodeWebhookAuthorized(
	configuredSecret: string | undefined,
	authHeader: string | undefined,
): boolean {
	return isBearerAuthorized(configuredSecret, authHeader);
}

// Filename / Content-Disposition helpers live in core (shared with the router's pre-signed
// path). Re-exported here so we don't break the worker's internal imports.
export { contentDispositionAttachment, contentDispositionInline, sanitizeFilename } from "@devultur/core";

export function base64UrlDecode(value: string) {
	const base64 = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// Subject of the service token the transcode runner uses to fetch the original. Reserved: `/v1/token` rejects a
// `userId` that starts with it. Internal to the package.
export const SERVICE_SUBJECT_PREFIX = "transcode:";
// `typ` claim of that service token. Only the transcode route sets it; viewer tokens never carry a `typ`.
export const SERVICE_TOKEN_TYPE = "transcode";

/**
 * True when a verified token payload is the Worker's own service token (by its `typ` claim, never its `sub`): a read
 * the Worker makes for itself, not a viewer's.
 */
export function isServiceToken(payload: Record<string, unknown> | null | undefined): boolean {
	return payload?.typ === SERVICE_TOKEN_TYPE;
}

/**
 * Verifies a viewer token (HMAC-SHA256 with `DELIVERY_SIGN_SECRET`) for the private delivery gate:
 * checks signature and expiration. Returns the payload if valid, `null` if not. Pure with respect to the
 * worker (it receives the secret) so it can be unit-tested. It does NOT check fingerprint/ip — that's the delivery
 * gate's job (`bindingMismatch` in routes/media.ts) after reading the object; here it's only "is this token authentic and current?".
 */
export async function verifyViewerToken(
	token: string | undefined,
	secret: string,
): Promise<Record<string, unknown> | null> {
	if (!token) return null;
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [headerB64, payloadB64, signatureB64] = parts;

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"verify",
	]);
	const valid = await crypto.subtle.verify(
		"HMAC",
		key,
		base64UrlDecode(signatureB64),
		encoder.encode(`${headerB64}.${payloadB64}`),
	);
	if (!valid) return null;

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
	} catch {
		return null;
	}

	const now = Math.floor(Date.now() / 1000);
	if (typeof payload.exp === "number" && payload.exp < now) return null;
	return withCurrentClaimNames(payload);
}

import {
	encodeEncryptionMeta,
	encryptBytes,
	exportEncryptionKey,
	generateEncryptionKey,
	generateId,
	generateIv,
	importEncryptionKey,
} from "@devultur/core";

/**
 * Generates the encryption key for ONE object and stores its material in `KEYS_BUCKET` under `${objectStorageKey}/${keyId}`
 * — the SAME path delivery derives from the object's storage key, without reconstructing the storage prefix (which isn't
 * always available on the credential-less PUT). Returns the key + IV and the envelope for the metadata
 * (`enc`). `keyMetadata` goes as customMetadata on the key object (e.g. the binding override).
 */
export async function createObjectEncryption(
	keysBucket: R2Bucket,
	objectStorageKey: string,
	keyMetadata?: Record<string, string>,
): Promise<{ cryptoKey: CryptoKey; iv: Uint8Array<ArrayBuffer>; enc: string }> {
	const cryptoKey = await generateEncryptionKey();
	const iv = generateIv();
	const keyId = generateId();
	await keysBucket.put(`${objectStorageKey}/${keyId}`, await exportEncryptionKey(cryptoKey), {
		...(keyMetadata && Object.keys(keyMetadata).length > 0 ? { customMetadata: keyMetadata } : {}),
	});
	return { cryptoKey, iv, enc: encodeEncryptionMeta(iv, keyId) };
}

/** Encrypts the whole `body` (AES-CTR) with a fresh key for the object. See `createObjectEncryption`. */
export async function encryptForStorage(
	keysBucket: R2Bucket,
	objectStorageKey: string,
	body: BufferSource,
	keyMetadata?: Record<string, string>,
): Promise<{ body: Uint8Array<ArrayBuffer>; enc: string }> {
	const { cryptoKey, iv, enc } = await createObjectEncryption(keysBucket, objectStorageKey, keyMetadata);
	return { body: await encryptBytes(body, cryptoKey, iv), enc };
}

/**
 * Is this object encrypted at-rest? Any private asset EXCEPT HLS segments/playlists (`.ts`/`.m3u8`):
 * those are already AES-128 encrypted by the transcode and hls.js decrypts them client-side — re-encrypting them would break
 * playback. Pure → testable.
 */
export function shouldEncryptAtRest(policy: SecurityPolicy, key: string, hasKeysBucket: boolean): boolean {
	const isHlsAsset = key.endsWith(".ts") || key.endsWith(".m3u8");
	return Boolean(policy.encrypt) && visibilityFromKey(key) === "private" && !isHlsAsset && hasKeysBucket;
}

/**
 * Loads the CryptoKey of an encrypted object from `KEYS_BUCKET` at `${objectStorageKey}/${keyId}`. Returns
 * `{ key, metadata }` or null if the bucket or the material is missing. The path is symmetric with `encryptForStorage`.
 */
export async function loadStorageKey(
	keysBucket: R2Bucket | undefined,
	objectStorageKey: string,
	keyId: string,
): Promise<{ key: CryptoKey; metadata: Record<string, string> | undefined } | null> {
	if (!keysBucket) return null;
	const stored = await keysBucket.get(`${objectStorageKey}/${keyId}`);
	if (!stored) return null;
	return { key: await importEncryptionKey(await stored.arrayBuffer()), metadata: stored.customMetadata };
}

const base64Url = (value: string) => btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Signs a viewer token (HMAC-SHA256 with `DELIVERY_SIGN_SECRET`). Pure signer shared by the token's
 * issuance (`/v1/token`) and the download token the transcode mints to fetch the raw. The
 * caller builds the payload (claims); this only signs it. Symmetric with `verifyViewerToken`.
 */
export async function signViewerToken(payload: Record<string, unknown>, secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payloadB64 = base64Url(JSON.stringify(payload));
	const signingInput = `${header}.${payloadB64}`;
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
	const signatureB64 = base64Url(String.fromCharCode(...new Uint8Array(signature)));
	return `${signingInput}.${signatureB64}`;
}

export async function hashKey(key: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(key);
	const hashBuffer = await crypto.subtle.digest(HashAlgorithm.SHA_256, data);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Lists and batch-deletes every object under `prefix` (R2 deletes up to 1000 keys/call) and returns how many it
 * deleted. Idempotent: empty prefix → 0. It bypasses object locks: routes delete through `guardedDeletePrefix` and
 * `deleteKeysFor` (object-lock/guard.ts). Use this only for regenerable data (image variants) or after the guard ran.
 */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
	let deletedCount = 0;
	let cursor: string | undefined;
	do {
		const listed = await bucket.list({ prefix, cursor });
		if (listed.objects.length > 0) {
			await bucket.delete(listed.objects.map((obj) => obj.key));
			deletedCount += listed.objects.length;
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
	return deletedCount;
}

export const KV_AUTH_TTL_SECONDS = 300;
export const KV_JOB_TTL_SECONDS = 86400;
export const UPLOAD_TOKEN_TTL_SECONDS = 3600;

export const KvPrefix = {
	UPLOAD_PENDING: "upload-pending",
	TRANSCODE_JOB: "transcode",
	TRANSCODE_META: "transcode-meta",
	TRANSCODE_STATUS: "transcode-status",
	// What to do with the raw once the transcode finishes successfully (by videoId: the webhook doesn't carry the job). See
	// transcode/raw-retention.ts.
	TRANSCODE_RAW: "transcode-raw",
	CAPTION_JOB: "caption",
	CAPTION_GROUP: "caption-group",
	CAPTION_STORED: "caption-stored",
} as const;
