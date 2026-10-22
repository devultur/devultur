// Content verification of an upload (see content-sniff.ts and `WorkerConfig.contentSniffing`): the first bytes of the
// plaintext are compared with the declared Content-Type. The single PUT checks its buffered body before encryption. A
// multipart upload's type is fixed when it starts, so every part 1 is checked when it arrives (before it's encrypted):
// a rejected one aborts the whole upload, and the complete must name the part 1 that was checked (its etag). A
// transcode's outputs (the Worker's own bytes, with the runner's types) are never checked.
import { decodeEncryptionMeta, type MultipartPart } from "@devultur/core";
import type { Context } from "hono";
import { SNIFF_HEAD_BYTES, type SniffResult, sniffContent } from "../content-sniff";
import { type ContentSniffingMode, getRequestState } from "../request-state";
import type { MultipartPending, UploadPending, WorkerApp } from "../types";
import { isTrustedDerivedOutput } from "./derived-upload";
import type { ResolvedPending } from "./upload-pending";

type UploadContext = Context<WorkerApp>;
type Mismatch = Extract<SniffResult, { verdict: "mismatch" }>;
type MismatchAction = "accepted" | "rejected" | "stored_as_octet_stream";

export const OCTET_STREAM = "application/octet-stream";

// A large upload can take longer than the single PUT's one-hour pending window.
export const MULTIPART_PENDING_TTL_SECONDS = 24 * 60 * 60;

function sniffingModeOf(context: UploadContext, pending: UploadPending | null): ContentSniffingMode {
	return pending?.contentSniffing ?? getRequestState(context).config?.contentSniffing ?? "scriptable";
}

/** Does this upload get its content checked? Everything but a transcode's outputs, unless the config turns it off. */
export function shouldSniffUpload(
	context: UploadContext,
	key: string,
	pending: UploadPending | null,
	contentType: string,
): boolean {
	const isRunnerWrite = pending ? Boolean(pending.isDerived) : true;
	if (isRunnerWrite && isTrustedDerivedOutput(key, contentType)) return false;
	return sniffingModeOf(context, pending) !== "off";
}

// A multipart upload can't be stored under another type: whatever isn't accepted is rejected.
function mismatchAction(mode: ContentSniffingMode, mismatch: Mismatch, isMultipart: boolean): MismatchAction {
	if (mode === "scriptable") return mismatch.isScriptable ? "rejected" : "accepted";
	if (mode === "octet-stream" && !isMultipart) return "stored_as_octet_stream";
	return "rejected";
}

function logMismatch(declared: string, mismatch: Mismatch, key: string, action: MismatchAction): void {
	console.warn(`[content-sniff] ${JSON.stringify({ declared, detected: mismatch.detected, key, action })}`);
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

function sniffHead(declared: string, body: ArrayBuffer): SniffResult {
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
	const { contentType, key, pending } = upload;
	if (!shouldSniffUpload(context, key, pending, contentType)) return { contentType };
	const result = sniffHead(contentType, upload.body);
	if (result.verdict !== "mismatch") return { contentType };
	const action = mismatchAction(sniffingModeOf(context, pending), result, false);
	logMismatch(contentType, result, key, action);
	if (action === "accepted") return { contentType };
	if (action === "stored_as_octet_stream") return { contentType: OCTET_STREAM };
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
 * Checks every upload of part 1 (a retry with other bytes too); other parts pass through. A rejected mismatch aborts
 * the upload and answers 415.
 */
export async function checkFirstPart(
	context: UploadContext,
	active: ActiveMultipart,
	key: string,
	partNumber: number,
	body: ArrayBuffer,
): Promise<Response | null> {
	const { pending, multipart } = active;
	if (partNumber !== 1 || !multipart.checksFirstPart) return null;
	const result = sniffHead(pending.contentType, body);
	if (result.verdict !== "mismatch") return null;
	const action = mismatchAction(sniffingModeOf(context, pending), result, true);
	logMismatch(pending.contentType, result, key, action);
	if (action === "accepted") return null;
	await discardMultipart(context, active);
	return contentTypeMismatch(context, pending.contentType, result.detected);
}

/** Once a checked part 1 is stored, its etag goes in the pending: the complete must name that part 1. */
export async function recordFirstPart(
	context: UploadContext,
	active: ActiveMultipart,
	partNumber: number,
	etag: string,
): Promise<void> {
	const { pending, multipart, kvKey } = active;
	if (partNumber !== 1 || !multipart.checksFirstPart) return;
	const recorded = { ...pending, multipart: { ...multipart, firstPartEtag: etag } };
	await context.env.MEDIA_KV.put(kvKey, JSON.stringify(recorded), { expirationTtl: MULTIPART_PENDING_TTL_SECONDS });
}

/**
 * `409 content_unverified` unless the complete's part 1 is the one that was checked. KV is eventually consistent, so
 * a complete right after part 1 may not see it yet: the SDK retries on this code.
 */
export function unverifiedFirstPart(
	context: UploadContext,
	multipart: MultipartPending,
	parts: MultipartPart[],
): Response | null {
	if (!multipart.checksFirstPart) return null;
	if (multipart.firstPartEtag && parts[0]?.etag === multipart.firstPartEtag) return null;
	return context.json(
		{ error: "Part 1 of this upload has not been checked yet, or was replaced", code: "content_unverified" },
		409,
	);
}
