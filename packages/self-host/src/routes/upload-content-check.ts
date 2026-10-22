// Content verification of an upload (see content-sniff.ts and `WorkerConfig.contentSniffing`): the first bytes of the
// plaintext must match the declared Content-Type. The single PUT checks its buffered body before encryption. A
// multipart upload's type is fixed when it starts, so part 1 is checked when it arrives (before it's encrypted): a
// mismatch aborts the whole upload, and the complete is refused until part 1 has passed. A transcode's outputs (the
// Worker's own bytes) are never checked.
import { decodeEncryptionMeta } from "@devultur/core";
import type { Context } from "hono";
import { SNIFF_HEAD_BYTES, sniffContent } from "../content-sniff";
import { type ContentSniffingMode, getRequestState } from "../request-state";
import type { MultipartPending, UploadPending, WorkerApp } from "../types";
import { isDerivedAssetKey } from "./derived-upload";
import type { ResolvedPending } from "./upload-pending";

type UploadContext = Context<WorkerApp>;

export const OCTET_STREAM = "application/octet-stream";

// A large upload can take longer than the single PUT's one-hour pending window.
export const MULTIPART_PENDING_TTL_SECONDS = 24 * 60 * 60;

function sniffingModeOf(context: UploadContext, pending: UploadPending | null): ContentSniffingMode {
	return pending?.contentSniffing ?? getRequestState(context).config?.contentSniffing ?? "reject";
}

/** Does this upload get its content checked? Everything but a transcode's outputs, unless the config turns it off. */
export function shouldSniffUpload(context: UploadContext, key: string, pending: UploadPending | null): boolean {
	const isDerived = pending ? Boolean(pending.isDerived) : isDerivedAssetKey(key);
	return !isDerived && sniffingModeOf(context, pending) !== "off";
}

function contentTypeMismatch(context: UploadContext, declared: string, detected: string): Response {
	return context.json(
		{
			error: `The file's content (${detected}) does not match its declared Content-Type ${declared}`,
			code: "content_type_mismatch",
			declared,
			detected,
		},
		415,
	);
}

function sniffHead(declared: string, body: ArrayBuffer) {
	return sniffContent(declared, new Uint8Array(body, 0, Math.min(body.byteLength, SNIFF_HEAD_BYTES)));
}

interface SinglePutContent {
	key: string;
	pending: UploadPending | null;
	contentType: string;
	body: ArrayBuffer;
}

/** The Content-Type a single PUT stores (`application/octet-stream` for a mismatch in that mode), or its 415. */
export function checkSinglePutContent(
	context: UploadContext,
	upload: SinglePutContent,
): { contentType: string } | { rejected: Response } {
	const { contentType } = upload;
	if (!shouldSniffUpload(context, upload.key, upload.pending)) return { contentType };
	const result = sniffHead(contentType, upload.body);
	if (result.verdict !== "mismatch") return { contentType };
	if (sniffingModeOf(context, upload.pending) === "octet-stream") return { contentType: OCTET_STREAM };
	return { rejected: contentTypeMismatch(context, contentType, result.detected) };
}

type ActiveMultipart = ResolvedPending & { multipart: MultipartPending };

// Drops everything the upload left: the R2 session (and its parts), the pending, and the encryption key of its object.
async function discardMultipart(context: UploadContext, active: ActiveMultipart): Promise<void> {
	const { pending, multipart, kvKey } = active;
	await context.env.MEDIA_BUCKET.resumeMultipartUpload(pending.storageKey, multipart.uploadId).abort();
	await context.env.MEDIA_KV.delete(kvKey);
	const meta = decodeEncryptionMeta(multipart.enc);
	if (meta && context.env.KEYS_BUCKET) await context.env.KEYS_BUCKET.delete(`${pending.storageKey}/${meta.keyId}`);
}

/**
 * Checks part 1 of a multipart upload that still awaits it (other parts pass through). A mismatch aborts the upload
 * and answers 415, in every mode: R2 can't change the type the upload started with. A pass is recorded in the
 * pending, which lets the complete through.
 */
export async function verifyFirstPart(
	context: UploadContext,
	active: ActiveMultipart,
	partNumber: number,
	body: ArrayBuffer,
): Promise<Response | null> {
	const { pending, multipart, kvKey } = active;
	if (partNumber !== 1 || !multipart.isContentUnverified) return null;
	const result = sniffHead(pending.contentType, body);
	if (result.verdict === "mismatch") {
		await discardMultipart(context, active);
		return contentTypeMismatch(context, pending.contentType, result.detected);
	}
	const { isContentUnverified: _verified, ...verified } = multipart;
	await context.env.MEDIA_KV.put(kvKey, JSON.stringify({ ...pending, multipart: verified }), {
		expirationTtl: MULTIPART_PENDING_TTL_SECONDS,
	});
	return null;
}

/** The complete waits for part 1's check: a client that sends parts out of order retries once part 1 is in. */
export function unverifiedContent(context: UploadContext, multipart: MultipartPending): Response | null {
	if (!multipart.isContentUnverified) return null;
	return context.json({ error: "Part 1 has not been uploaded and checked yet", code: "content_unverified" }, 409);
}
