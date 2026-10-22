// Test-only: the upload router over an in-memory R2 (single put, multipart create/resume/abort), KV and keys bucket,
// for the content verification tests. Not exported from the package.
import { MULTIPART_PART_SIZE_BYTES, type MultipartPart } from "@devultur/core";
import { Hono } from "hono";
import { type ContentSniffingMode, updateRequestState } from "../request-state";
import type { WorkerApp } from "../types";
import { upload } from "./upload";

export const PART = MULTIPART_PART_SIZE_BYTES;
const encoder = new TextEncoder();
export const PDF = encoder.encode("%PDF-1.7\n%âã\n1 0 obj\n");
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
export const HTML = encoder.encode("<!doctype html><script>alert(document.cookie)</script>");
// An MP4's `ftyp` box.
export const MP4_HEAD = new Uint8Array([0, 0, 0, 16, ...encoder.encode("ftypisom"), 0, 0, 2, 0]);
export const WEBM_HEAD = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, ...encoder.encode("webm")]);

/** `length` bytes that start with `head`. */
export function withHead(head: Uint8Array, length: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(length);
	bytes.set(head.subarray(0, length));
	return bytes;
}

export interface SetupOptions {
	contentSniffing?: ContentSniffingMode;
	isEncrypted?: boolean;
	isAuthenticated?: boolean;
}

interface Session {
	key: string;
	contentType?: string;
	isAborted: boolean;
	/** Etag of the last upload of each part (a re-upload gets a new one, like R2). */
	etags: Map<number, string>;
}

export function setup(options: SetupOptions = {}) {
	const kv = new Map<string, string>();
	const objects = new Map<string, { options: R2PutOptions | undefined }>();
	const sessions = new Map<string, Session>();
	const keys = new Map<string, ArrayBuffer>();
	let partUploadCount = 0;
	const resume = (_key: string, uploadId: string) => {
		const session = sessions.get(uploadId);
		return {
			uploadPart: async (partNumber: number) => {
				const etag = `etag-${partNumber}-${++partUploadCount}`;
				session?.etags.set(partNumber, etag);
				return { partNumber, etag };
			},
			complete: async () => ({ size: 0 }),
			abort: async () => {
				if (session) session.isAborted = true;
			},
		};
	};
	const env = {
		MEDIA_KV: {
			get: async (key: string) => kv.get(key) ?? null,
			put: async (key: string, value: string) => void kv.set(key, value),
			delete: async (key: string) => void kv.delete(key),
		},
		MEDIA_BUCKET: {
			head: async () => null,
			list: async () => ({ objects: [] }),
			put: async (key: string, _value: unknown, putOptions?: R2PutOptions) => {
				objects.set(key, { options: putOptions });
				return {};
			},
			createMultipartUpload: async (key: string, multipartOptions?: R2MultipartOptions) => {
				const uploadId = `up-${sessions.size + 1}`;
				const contentType = (multipartOptions?.httpMetadata as R2HTTPMetadata | undefined)?.contentType;
				sessions.set(uploadId, { key, contentType, isAborted: false, etags: new Map() });
				return { uploadId, key, ...resume(key, uploadId) };
			},
			resumeMultipartUpload: resume,
		},
		KEYS_BUCKET: {
			put: async (path: string, body: Uint8Array) => void keys.set(path, body.slice().buffer),
			get: async (path: string) => {
				const stored = keys.get(path);
				return stored ? { arrayBuffer: async () => stored, customMetadata: undefined } : null;
			},
			head: async (path: string) => (keys.has(path) ? { key: path } : null),
			delete: async (path: string) => void keys.delete(path),
		},
	};
	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		updateRequestState(context, {
			storagePrefix: "",
			config: {
				...(options.contentSniffing ? { contentSniffing: options.contentSniffing } : {}),
				...(options.isEncrypted ? { security: { encrypt: true } } : {}),
			},
			...(options.isAuthenticated ? { access: { authenticated: true } } : {}),
		});
		await next();
	});
	app.route("/v1/upload", upload);
	const send = (path: string, init: RequestInit) => app.request(path, init, env as never);
	const postJson = (path: string, body: unknown) => send(path, { method: "POST", body: JSON.stringify(body) });
	const withQuery = (url: string, query: string) => `${url}${url.includes("?") ? "&" : "?"}${query}`;

	/** `POST /v1/upload` as a client would: the upload URL that carries the pending. */
	async function createUpload(contentType: string, filename: string, visibility = "public") {
		const res = await postJson("/v1/upload", { filename, contentType, visibility });
		return ((await res.json()) as { key: string; uploadUrl: string }).uploadUrl;
	}
	const put = (url: string, contentType: string, body: Uint8Array<ArrayBuffer>) =>
		send(url, { method: "PUT", headers: { "Content-Type": contentType }, body });
	const createMultipart = async (url: string, size: number, body: Record<string, unknown> = {}) => {
		const res = await postJson(withQuery(url, "multipart=create"), { size, ...body });
		return ((await res.json()) as { uploadId: string }).uploadId;
	};
	const putPart = (url: string, uploadId: string, partNumber: number, body: Uint8Array<ArrayBuffer>) =>
		send(withQuery(url, `uploadId=${uploadId}&partNumber=${partNumber}`), { method: "PUT", body });
	/** Completes with the etag of each part's last upload, or the `parts` given. */
	const complete = (url: string, uploadId: string, partCount: number, parts?: MultipartPart[]) => {
		const etags = sessions.get(uploadId)?.etags;
		const lastParts = Array.from({ length: partCount }, (_, index) => ({
			partNumber: index + 1,
			etag: etags?.get(index + 1) ?? "missing",
		}));
		return postJson(withQuery(url, "multipart=complete"), { uploadId, parts: parts ?? lastParts });
	};

	return { kv, objects, sessions, keys, createUpload, put, createMultipart, putPart, complete };
}

export const storedContentType = (stored: { options: R2PutOptions | undefined } | undefined) =>
	(stored?.options?.httpMetadata as R2HTTPMetadata | undefined)?.contentType;
