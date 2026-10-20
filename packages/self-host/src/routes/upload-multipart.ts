// Multipart upload (files > ~100 MB, a Worker's per-request body limit) under the SAME capability model
// as the single PUT: the authenticated POST /v1/upload leaves the pending in KV, and these
// credential-less routes only operate on the pending named by the URL's id (`?u=…`, see upload-pending.ts). Query
// protocol, on top of the URL's (see core/multipart.ts):
//   POST   ?multipart=create          { size }               → { uploadId, partSize, partCount }
//   PUT    ?uploadId=…&partNumber=N   <bytes>                → { partNumber, etag }
//   POST   ?multipart=complete        { uploadId, parts }    → { key, size }
//   DELETE ?uploadId=…                                       → { aborted: true }
// Each part must measure EXACTLY what it's supposed to, per the size declared at create → the final object
// can't exceed the pending's `maxSizeBytes` (which create validates). If the object is encrypted (L4), the key
// gets created at create time and each part is encrypted with the AES-CTR counter for its offset → the full object
// is the same ciphertext the single PUT would produce, and delivery decrypts it the same way.
import {
	AES_BLOCK_BYTES,
	classifyUploadRequest,
	counterForBlock,
	decodeEncryptionMeta,
	encryptBytes,
	MULTIPART_PART_SIZE_BYTES,
	MULTIPART_QUERY,
	type MultipartPart,
	multipartPartCount,
	multipartPartRange,
	resolveSecurity,
	UploadRequestKind,
} from "@devultur/core";
import type { Context } from "hono";
import { contentDispositionInline, createObjectEncryption, loadStorageKey, shouldEncryptAtRest } from "../helpers";
import { prepareUploadWrite } from "../object-lock/upload-write";
import { getRequestState } from "../request-state";
import type { MultipartPending, UploadPending, WorkerApp } from "../types";
import { derivedAssetPending } from "./derived-upload";
import {
	allowedUploadMetadata,
	digestBody,
	discardStaleVariants,
	headerSha256,
	integrityMetadata,
	lockMetadata,
	sha256Mismatch,
	targetFailure,
} from "./upload-integrity";
import { derivedSessionKvKey, lookupUploadPending, type ResolvedPending, uploadNotFound } from "./upload-pending";
import { isUploadTargetError, resolveDeclaredSha256 } from "./upload-target";

// A large upload can take longer than the single PUT's one-hour pending window.
const MULTIPART_PENDING_TTL_SECONDS = 24 * 60 * 60;
// R2's (and S3's) limit on parts per upload.
const MAX_PART_COUNT = 10_000;

type UploadContext = Context<WorkerApp>;

async function readMultipartAt(context: UploadContext, kvKey: string): Promise<MultipartPending | undefined> {
	const raw = await context.env.MEDIA_KV.get(kvKey);
	try {
		return raw ? (JSON.parse(raw) as UploadPending).multipart : undefined;
	} catch {
		return undefined;
	}
}

/** Pending with an active multipart whose uploadId matches the requested one. */
async function readActiveMultipart(
	context: UploadContext,
	key: string,
	uploadId: string | undefined,
): Promise<(ResolvedPending & { multipart: MultipartPending }) | null> {
	const resolved = await lookupUploadPending(context, key);
	const multipart = resolved?.pending.multipart;
	if (!resolved || !multipart || !uploadId || multipart.uploadId !== uploadId) return null;
	return { ...resolved, multipart };
}

/** Capability request type (core: the same rule a layer embedding the worker can use). */
export function uploadRequestKindOf(context: UploadContext): UploadRequestKind | null {
	return classifyUploadRequest(context.req.method, new URL(context.req.url).searchParams);
}

export const invalidMultipartRequest = (context: UploadContext) =>
	context.json({ error: "uploadId and partNumber are required for multipart calls", code: "invalid_multipart" }, 400);

/** Exact bytes that part `partNumber` must measure, or null if the number isn't valid. Pure → testable. */
export function expectedPartBytes(multipart: MultipartPending, partNumber: number): number | null {
	const partCount = multipartPartCount(multipart.size, multipart.partSize);
	if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount) return null;
	const { start, end } = multipartPartRange(partNumber, multipart.size, multipart.partSize);
	return end - start;
}

/** Valid parts for the complete: exactly 1..partCount, no repeats, with an etag. Pure → testable. */
export function normalizeCompletedParts(multipart: MultipartPending, parts: unknown): MultipartPart[] | null {
	if (!Array.isArray(parts)) return null;
	const partCount = multipartPartCount(multipart.size, multipart.partSize);
	if (parts.length !== partCount) return null;
	const sorted = parts
		.map((part) => part as Partial<MultipartPart>)
		.filter((part): part is MultipartPart => Number.isInteger(part.partNumber) && typeof part.etag === "string")
		.sort((a, b) => a.partNumber - b.partNumber);
	const isComplete = sorted.length === partCount && sorted.every((part, index) => part.partNumber === index + 1);
	return isComplete ? sorted.map((part) => ({ partNumber: part.partNumber, etag: part.etag })) : null;
}

async function handleMultipartCreate(context: UploadContext, key: string, target: ResolvedPending): Promise<Response> {
	const { pending, kvKey } = target;
	const body = (await context.req.json().catch(() => null)) as { size?: unknown; sha256?: unknown } | null;
	const size = Number(body?.size);
	if (!Number.isSafeInteger(size) || size <= 0) {
		return context.json({ error: "size must be a positive integer", code: "invalid_size" }, 400);
	}
	const declaredSha256 = resolveDeclaredSha256(body?.sha256 ?? pending.sha256);
	if (isUploadTargetError(declaredSha256)) return targetFailure(context, declaredSha256);
	if (pending.maxSizeBytes != null && size > pending.maxSizeBytes) {
		return context.json(
			{
				error: "File exceeds the allowed size for this media type",
				code: "file_too_large",
				limit: pending.maxSizeBytes,
			},
			413,
		);
	}
	const partSize = MULTIPART_PART_SIZE_BYTES;
	const partCount = multipartPartCount(size, partSize);
	if (partCount > MAX_PART_COUNT) {
		return context.json({ error: "File is too large for a multipart upload", code: "file_too_large" }, 413);
	}
	// Retry of the create (lost response): same session, not a second orphaned upload in R2. Only reachable by
	// whoever presented the pending's id (or the authenticated request for a derived asset): the uploadId is never given to anyone else.
	if (pending.multipart) {
		return context.json({ uploadId: pending.multipart.uploadId, partSize: pending.multipart.partSize, partCount });
	}
	// Before the encryption key and the R2 session: a taken asset or a locked object gets nothing created.
	const write = await prepareUploadWrite(context, pending.key ?? key, pending, pending.storageKey);
	if ("blocked" in write) return write.blocked;

	// A multipart's metadata gets fixed at create time: the sha256 is the DECLARED one (`sha256Verified: false`); the
	// worker verifies each part against its own but never rehashes the complete object.
	const customMetadata: Record<string, string> = {
		...allowedUploadMetadata(pending.uploadMetadata),
		...integrityMetadata(declaredSha256, false, pending.expiresAt),
		...lockMetadata(pending.lock),
	};
	if (pending.security) customMetadata.security = JSON.stringify(pending.security);
	const policy = resolveSecurity(pending.security, getRequestState(context).config?.security);
	let enc: string | undefined;
	if (context.env.KEYS_BUCKET && shouldEncryptAtRest(policy, key, true)) {
		({ enc } = await createObjectEncryption(context.env.KEYS_BUCKET, pending.storageKey, { ...customMetadata }));
		customMetadata.enc = enc;
	}

	const multipartUpload = await context.env.MEDIA_BUCKET.createMultipartUpload(pending.storageKey, {
		// Video raw: the class the POST resolved from the config's retention setting (see upload.ts).
		storageClass: pending.storageClass ?? "Standard",
		httpMetadata: {
			contentType: pending.contentType,
			...(pending.originalFilename ? { contentDisposition: contentDispositionInline(pending.originalFilename) } : {}),
			...(pending.cacheControl ? { cacheControl: pending.cacheControl } : {}),
		},
		...(Object.keys(customMetadata).length > 0 ? { customMetadata } : {}),
	});

	const multipart: MultipartPending = {
		uploadId: multipartUpload.uploadId,
		size,
		partSize,
		...(enc ? { enc } : {}),
		...(declaredSha256 ? { sha256: declaredSha256 } : {}),
	};
	await context.env.MEDIA_KV.put(kvKey, JSON.stringify({ ...pending, multipart }), {
		expirationTtl: MULTIPART_PENDING_TTL_SECONDS,
	});
	// Two concurrent creates: the session that landed in the pending wins; the other gets aborted in R2 instead of
	// being left orphaned. (KV isn't atomic: whatever slips through gets cleaned up by the bucket's lifecycle rule, see the runbook.)
	const winner = await readMultipartAt(context, kvKey);
	if (winner && winner.uploadId !== multipart.uploadId) {
		await multipartUpload.abort();
		return context.json({ uploadId: winner.uploadId, partSize: winner.partSize, partCount });
	}
	return context.json({ uploadId: multipart.uploadId, partSize, partCount });
}

// Encrypts the part with the counter for the block it starts on (offset a multiple of 16: partSize is).
async function encryptPart(
	context: UploadContext,
	pending: UploadPending,
	multipart: MultipartPending,
	partNumber: number,
	body: ArrayBuffer,
): Promise<ArrayBuffer | Uint8Array<ArrayBuffer> | null> {
	if (!multipart.enc) return body;
	const meta = decodeEncryptionMeta(multipart.enc);
	const material = meta ? await loadStorageKey(context.env.KEYS_BUCKET, pending.storageKey, meta.keyId) : null;
	if (!meta || !material) return null;
	const startBlock = ((partNumber - 1) * multipart.partSize) / AES_BLOCK_BYTES;
	return encryptBytes(body, material.key, counterForBlock(meta.iv, startBlock));
}

export async function handleMultipartPart(context: UploadContext): Promise<Response> {
	const key = context.req.param("key") ?? "";
	const active = await readActiveMultipart(context, key, context.req.query(MULTIPART_QUERY.UPLOAD_ID));
	if (!active) return uploadNotFound(context);
	const { pending, multipart } = active;

	const partNumber = Number(context.req.query(MULTIPART_QUERY.PART_NUMBER));
	const expectedBytes = expectedPartBytes(multipart, partNumber);
	if (expectedBytes == null) return context.json({ error: "Invalid partNumber", code: "invalid_part" }, 400);
	// Before buffering: a part declared larger than its share gets rejected without reading it.
	const declaredBytes = Number(context.req.header("content-length") ?? "0");
	if (Number.isFinite(declaredBytes) && declaredBytes > expectedBytes) {
		return context.json({ error: "Part size does not match the upload plan", code: "part_size_mismatch" }, 400);
	}

	const body = await context.req.arrayBuffer();
	if (body.byteLength !== expectedBytes) {
		return context.json({ error: "Part size does not match the upload plan", code: "part_size_mismatch" }, 400);
	}
	const partChecksumFailure = await checkPartSha256(context, multipart, body);
	if (partChecksumFailure) return partChecksumFailure;
	const storedPart = await encryptPart(context, pending, multipart, partNumber, body);
	if (!storedPart) return context.json({ error: "Encryption key not found for this upload" }, 500);

	const multipartUpload = context.env.MEDIA_BUCKET.resumeMultipartUpload(pending.storageKey, multipart.uploadId);
	const uploaded = await multipartUpload.uploadPart(partNumber, storedPart);
	return context.json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
}

async function handleMultipartComplete(context: UploadContext, key: string): Promise<Response> {
	const body = (await context.req.json().catch(() => null)) as { uploadId?: string; parts?: unknown } | null;
	const active = await readActiveMultipart(context, key, body?.uploadId);
	if (!active) return uploadNotFound(context);
	const { pending, multipart, kvKey } = active;

	const parts = normalizeCompletedParts(multipart, body?.parts);
	if (!parts) return context.json({ error: "parts must list every part exactly once", code: "invalid_parts" }, 400);

	// R2 has no conditional complete: an asset that appeared, or a lock set, after the create gets rejected here
	// (best-effort: a lock set between this check and the complete isn't seen, the window decision 2 of #3 accepts).
	const write = await prepareUploadWrite(context, pending.key ?? key, pending, pending.storageKey);
	if ("blocked" in write) return write.blocked;
	const multipartUpload = context.env.MEDIA_BUCKET.resumeMultipartUpload(pending.storageKey, multipart.uploadId);
	const object = await multipartUpload.complete(parts);
	await context.env.MEDIA_KV.delete(kvKey);
	await discardStaleVariants(context.env.MEDIA_BUCKET, pending);
	const integrity = multipart.sha256 ? { sha256: multipart.sha256, sha256Verified: false } : {};
	return context.json({ key, size: object.size, ...integrity });
}

// With a declared sha256, each part carries its own (of the plaintext) and it's verified before storing it: the
// final object is exactly the bytes the client hashed, part by part.
async function checkPartSha256(
	context: UploadContext,
	multipart: MultipartPending,
	body: ArrayBuffer,
): Promise<Response | null> {
	const partSha256 = headerSha256(context);
	if (partSha256 === null) {
		return context.json({ error: "x-devultur-sha256 must be a 64-character hex string", code: "invalid_sha256" }, 400);
	}
	if (multipart.sha256 && !partSha256) {
		return context.json(
			{
				error: "Each part must carry its x-devultur-sha256 when the upload declares one",
				code: "part_sha256_required",
			},
			400,
		);
	}
	if (!partSha256) return null;
	const digest = await digestBody(body, undefined, partSha256);
	if ("mismatch" in digest) return sha256Mismatch(context, digest.mismatch.expected, digest.mismatch.actual);
	return null;
}

/** `POST /v1/upload/<key>?multipart=create|complete`. */
export async function handleMultipartPost(context: UploadContext): Promise<Response> {
	const key = context.req.param("key") ?? "";
	const kind = uploadRequestKindOf(context);
	if (kind === UploadRequestKind.MULTIPART_COMPLETE) return handleMultipartComplete(context, key);
	if (kind === UploadRequestKind.INVALID) return invalidMultipartRequest(context);
	if (kind !== UploadRequestKind.MULTIPART_CREATE) return context.json({ error: "Not found" }, 404);

	const resolved = await lookupUploadPending(context, key);
	if (resolved === null) return uploadNotFound(context);
	if (resolved) return handleMultipartCreate(context, key, resolved);
	// A transcode-derived asset (a large MP4) has no pending: the create builds one for its fixed key.
	const derived = await derivedAssetPending(context, key);
	const derivedKvKey = derivedSessionKvKey(context, key);
	if (!derived || !derivedKvKey) return uploadNotFound(context);
	return handleMultipartCreate(context, key, { pending: derived, kvKey: derivedKvKey });
}

/** `DELETE /v1/upload/<key>?uploadId=…`: aborts the multipart and releases the pending. */
export async function handleMultipartAbort(context: UploadContext): Promise<Response> {
	if (uploadRequestKindOf(context) !== UploadRequestKind.MULTIPART_ABORT) return invalidMultipartRequest(context);
	const key = context.req.param("key") ?? "";
	const active = await readActiveMultipart(context, key, context.req.query(MULTIPART_QUERY.UPLOAD_ID));
	if (!active) return uploadNotFound(context);
	await context.env.MEDIA_BUCKET.resumeMultipartUpload(active.pending.storageKey, active.multipart.uploadId).abort();
	await context.env.MEDIA_KV.delete(active.kvKey);
	return context.json({ aborted: true });
}
