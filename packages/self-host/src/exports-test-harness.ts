// Harness for the private exports tests: in-memory R2 with metadata, `uploaded`, `onlyIf` (If-None-Match: * and
// `etagMatches`), ranges and
// multipart; in-memory KV; and a Durable Objects namespace that instantiates the real `DownloadLink` class with an
// in-memory storage and a `blockConcurrencyWhile` that, like the Workers one, doesn't let anything else run meanwhile.
import type { CacheRule, ObjectLock, SecurityPolicy } from "@devultur/core";
import { Hono } from "hono";
import { DownloadLink, type DownloadLinkState, type DownloadLinkStorage } from "./download-link";
import { type PluginContext, updateRequestState } from "./request-state";
import { assets } from "./routes/assets";
import { download, handleDownloadLink } from "./routes/download";
import { media } from "./routes/media";
import { token } from "./routes/token";
import { upload } from "./routes/upload";
import type { UploadGrant, WorkerApp, WorkerVariables } from "./types";

export const SIGN_SECRET = "delivery-secret";

interface StoredObject {
	bytes: Uint8Array;
	httpMetadata: Record<string, string>;
	customMetadata: Record<string, string>;
	/** Set by every write; a test that seeds `objects` directly may leave it out (the epoch). */
	uploaded?: Date;
	/** Changes on every write, so `onlyIf.etagMatches` can tell a stale read from the current object. */
	etag?: string;
}

interface PutOptions {
	httpMetadata?: Record<string, string>;
	customMetadata?: Record<string, string>;
	onlyIf?: Headers | { etagMatches?: string };
}

export interface MemoryBucketOptions {
	/** `uploaded` of each write. Default: the epoch, so listings stay deterministic. */
	now?: () => Date;
}

function failsCondition(onlyIf: PutOptions["onlyIf"], existing: StoredObject | undefined): boolean {
	if (!onlyIf) return false;
	if (onlyIf instanceof Headers) return onlyIf.get("If-None-Match") === "*" && existing !== undefined;
	if (onlyIf.etagMatches === undefined) return false;
	return !existing || (existing.etag ?? "etag-0") !== onlyIf.etagMatches.replaceAll('"', "");
}

function toBytes(value: ArrayBuffer | Uint8Array | string): Uint8Array {
	return typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
}

function r2Body(key: string, stored: StoredObject, bytes = stored.bytes) {
	return {
		key,
		size: stored.bytes.byteLength,
		etag: stored.etag ?? "etag-0",
		httpEtag: `"${stored.etag ?? "etag-0"}"`,
		uploaded: stored.uploaded ?? new Date(0),
		httpMetadata: stored.httpMetadata,
		customMetadata: stored.customMetadata,
		body: new Blob([bytes as BlobPart]).stream(),
		arrayBuffer: async () => bytes.slice().buffer,
		text: async () => new TextDecoder().decode(bytes),
	};
}

export function memoryBucket({ now = () => new Date(0) }: MemoryBucketOptions = {}) {
	const objects = new Map<string, StoredObject>();
	let writes = 0;
	const stamp = () => ({ uploaded: now(), etag: `etag-${++writes}` });
	const sessions = new Map<string, { key: string; options: PutOptions; parts: Map<number, Uint8Array> }>();
	const resumeMultipartUpload = (key: string, uploadId: string) => ({
		uploadPart: async (partNumber: number, value: ArrayBuffer | Uint8Array) => {
			sessions.get(uploadId)?.parts.set(partNumber, toBytes(value));
			return { partNumber, etag: `etag-${partNumber}` };
		},
		complete: async (parts: Array<{ partNumber: number }>) => {
			const session = sessions.get(uploadId);
			const chunks = parts.map((part) => session?.parts.get(part.partNumber) ?? new Uint8Array());
			const bytes = new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer());
			objects.set(key, {
				bytes,
				httpMetadata: session?.options.httpMetadata ?? {},
				customMetadata: session?.options.customMetadata ?? {},
				...stamp(),
			});
			return { size: bytes.byteLength };
		},
		abort: async () => void sessions.delete(uploadId),
	});
	return {
		objects,
		put: async (key: string, value: ArrayBuffer | Uint8Array | string, options: PutOptions = {}) => {
			if (failsCondition(options.onlyIf, objects.get(key))) return null;
			objects.set(key, {
				bytes: toBytes(value),
				httpMetadata: options.httpMetadata ?? {},
				customMetadata: options.customMetadata ?? {},
				...stamp(),
			});
			return { key };
		},
		get: async (key: string, options?: { range?: { offset: number; length: number } }) => {
			const stored = objects.get(key);
			if (!stored) return null;
			const range = options?.range;
			return r2Body(key, stored, range ? stored.bytes.slice(range.offset, range.offset + range.length) : undefined);
		},
		head: async (key: string) => {
			const stored = objects.get(key);
			if (!stored) return null;
			const { size, etag, httpEtag, uploaded, httpMetadata, customMetadata } = r2Body(key, stored);
			return { key, size, etag, httpEtag, uploaded, httpMetadata, customMetadata };
		},
		list: async ({ prefix = "", limit = 1000, cursor }: { prefix?: string; limit?: number; cursor?: string }) => {
			const start = Number(cursor ?? "0");
			const matching = [...objects.entries()].filter(([key]) => key.startsWith(prefix)).sort();
			const page = matching.slice(start, start + limit);
			const truncated = start + limit < matching.length;
			return {
				objects: page.map(([key, stored]) => ({
					key,
					size: stored.bytes.byteLength,
					etag: stored.etag ?? "etag-0",
					httpEtag: `"${stored.etag ?? "etag-0"}"`,
					uploaded: stored.uploaded ?? new Date(0),
					httpMetadata: stored.httpMetadata,
					customMetadata: stored.customMetadata,
				})),
				truncated,
				...(truncated ? { cursor: String(start + limit) } : {}),
			};
		},
		delete: async (keys: string | string[]) => {
			for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
		},
		createMultipartUpload: async (key: string, options: PutOptions = {}) => {
			const uploadId = `up-${sessions.size + 1}`;
			sessions.set(uploadId, { key, options, parts: new Map() });
			return { key, uploadId, ...resumeMultipartUpload(key, uploadId) };
		},
		resumeMultipartUpload,
	};
}

export type MemoryBucket = ReturnType<typeof memoryBucket>;

function memoryKv() {
	const entries = new Map<string, string>();
	return {
		entries,
		get: async (key: string) => entries.get(key) ?? null,
		put: async (key: string, value: string) => void entries.set(key, value),
		delete: async (key: string) => void entries.delete(key),
	};
}

function memoryDurableStorage(): DownloadLinkStorage & { alarm?: number } {
	const values = new Map<string, unknown>();
	const storage: DownloadLinkStorage & { alarm?: number } = {
		get: async <T>(key: string) => values.get(key) as T | undefined,
		put: async <T>(key: string, value: T) => void values.set(key, value),
		deleteAll: async () => values.clear(),
		setAlarm: async (time: number) => {
			storage.alarm = time;
		},
	};
	return storage;
}

// Real `blockConcurrencyWhile`: nothing else runs in the instance until the callback finishes (per-instance queue).
function memoryDurableState(): DownloadLinkState {
	let tail: Promise<unknown> = Promise.resolve();
	return {
		storage: memoryDurableStorage(),
		blockConcurrencyWhile: <T>(callback: () => Promise<T>) => {
			const run = tail.then(callback);
			tail = run.catch(() => {});
			return run;
		},
	};
}

/** In-memory DO namespace: one `DownloadLink` instance per name. */
export function downloadLinkNamespace() {
	const instances = new Map<string, DownloadLink>();
	const instanceFor = (name: string) => {
		const existing = instances.get(name);
		if (existing) return existing;
		const created = new DownloadLink(memoryDurableState());
		instances.set(name, created);
		return created;
	};
	return {
		instances,
		idFromName: (name: string) => name,
		get: (id: string) => ({
			fetch: (input: string, init?: RequestInit) => instanceFor(id).fetch(new Request(input, init)),
		}),
	};
}

/** Scope of the test worker (beyond its `prefix-a/` storage prefix) and other context variables. */
export interface ExportsWorkerOptions extends Partial<WorkerVariables> {
	uploadGrant?: UploadGrant;
	ownerAccess?: boolean;
	security?: SecurityPolicy;
	cacheRules?: CacheRule[];
	context?: PluginContext;
	maxFileLifetimeSeconds?: number;
	uploadMetadata?: Record<string, string>;
	lock?: ObjectLock;
}

export function exportsWorker(options: ExportsWorkerOptions = {}) {
	const {
		uploadGrant,
		ownerAccess,
		security,
		cacheRules,
		context: pluginContext,
		maxFileLifetimeSeconds,
		uploadMetadata,
		lock,
		...variables
	} = options;
	const mediaBucket = memoryBucket();
	const keysBucket = memoryBucket();
	const kv = memoryKv();
	const links = downloadLinkNamespace();
	const app = new Hono<WorkerApp>();
	app.use("*", async (context, next) => {
		updateRequestState(context, {
			storagePrefix: "prefix-a/",
			config: {
				...(security ? { security } : {}),
				...(cacheRules ? { cacheRules } : {}),
				...(maxFileLifetimeSeconds ? { maxFileLifetimeSeconds } : {}),
				...(uploadMetadata ? { uploadMetadata } : {}),
				...(lock ? { lock } : {}),
			},
			access: { ...(uploadGrant ? { uploadGrant } : {}), ...(ownerAccess ? { trustedRead: true } : {}) },
			...(pluginContext ? { context: pluginContext } : {}),
		});
		for (const [name, value] of Object.entries(variables)) context.set(name as keyof WorkerVariables, value as never);
		await next();
	});
	app.route("/v1/upload", upload);
	app.route("/v1/media", media);
	app.route("/v1/token", token);
	app.post("/v1/token/download", handleDownloadLink);
	app.route("/v1/download", download);
	app.route("/v1/assets", assets);
	const env = {
		MEDIA_BUCKET: mediaBucket,
		KEYS_BUCKET: keysBucket,
		MEDIA_KV: kv,
		DOWNLOAD_LINKS: links,
		DELIVERY_SIGN_SECRET: SIGN_SECRET,
	} as unknown as WorkerApp["Bindings"];
	const waits: Promise<unknown>[] = [];
	const executionCtx = {
		waitUntil: (promise: Promise<unknown>) => void waits.push(promise),
		passThroughOnException: () => {},
	} as never;
	const settle = () => Promise.all(waits.splice(0));
	const send = (path: string, init: RequestInit = {}) => app.request(`http://worker${path}`, init, env, executionCtx);
	const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
		send(path, {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "Content-Type": "application/json", ...headers },
		});
	return { app, env, mediaBucket, keysBucket, kv, links, send, postJson, settle };
}
