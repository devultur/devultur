// usage-log: record what the Worker serves (bytes and requests of media delivery and download links) into a sink of
// yours: the log by default, or a D1 table you can query per storage prefix and day.
//
//   createWorker({ plugins: [...defaultPlugins(config), usageLog({ sink: d1Sink("USAGE_DB") })] })
import {
	getRequestState,
	getRouteResult,
	isImageOriginRequest,
	type PluginContext,
	type WorkerPlugin,
} from "@devultur/self-host";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

export interface UsageRecord {
	/** Epoch ms when the response started. */
	at: number;
	storagePrefix: string;
	/** Media key (`{visibility}/…`) relative to the storage prefix. */
	key: string;
	/** 200, or 206 for a range request. */
	status: number;
	/** Bytes of the body that reached the client (fewer than the file if it hung up). */
	bytes: number;
	/** Plugin context of the request that issued the download link, if it was one. */
	context?: PluginContext;
}

export interface UsageSink {
	record(record: UsageRecord, context: Context): void | Promise<void>;
}

/** One `[usage]` JSON line per response. */
export const logSink: UsageSink = {
	record: (record) => console.log("[usage]", JSON.stringify(record)),
};

/**
 * Rows in a D1 table, from the binding `binding`:
 * `CREATE TABLE media_usage (at INTEGER, storage_prefix TEXT, media_key TEXT, status INTEGER, bytes INTEGER)`.
 */
export function d1Sink(binding: string): UsageSink {
	return {
		record: async (record, context) => {
			const database = (context.env as Record<string, D1Database>)[binding];
			await database
				.prepare("INSERT INTO media_usage (at, storage_prefix, media_key, status, bytes) VALUES (?, ?, ?, ?, ?)")
				.bind(record.at, record.storagePrefix, record.key, record.status, record.bytes)
				.run();
		},
	};
}

const MEDIA_PREFIX = "/v1/media/";
const DOWNLOAD_PREFIX = "/v1/download/";

// What the response served: a media key under the request's storage prefix, or the file of a redeemed link.
function servedFile(context: Context): Pick<UsageRecord, "storagePrefix" | "key" | "context"> | null {
	const { path } = context.req;
	if (path.startsWith(MEDIA_PREFIX)) {
		return { storagePrefix: getRequestState(context).storagePrefix, key: path.slice(MEDIA_PREFIX.length) };
	}
	const link = path.startsWith(DOWNLOAD_PREFIX) ? getRouteResult(context).redeemedLink : undefined;
	return link ? { storagePrefix: link.storagePrefix, key: link.key, context: link.context } : null;
}

// The body, counted as it streams to the client; `onDone` gets the total once it ends.
function countedBody(response: Response, onDone: (bytes: number) => void): Response {
	if (!response.body) {
		onDone(0);
		return response;
	}
	let bytes = 0;
	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			bytes += chunk.byteLength;
			controller.enqueue(chunk);
		},
		flush: () => onDone(bytes),
	});
	return new Response(response.body.pipeThrough(counter), response);
}

export function usageLog(options: { sink?: UsageSink } = {}): WorkerPlugin {
	const sink = options.sink ?? logSink;
	const record = createMiddleware<{ Bindings: { DELIVERY_SIGN_SECRET: string } }>(async (context, next) => {
		const at = Date.now();
		await next();
		const { status } = context.res;
		if (context.req.method !== "GET" || (status !== 200 && status !== 206)) return;
		// Cloudflare Images fetching an original for a transform: not a delivery to a viewer.
		if (await isImageOriginRequest(context.req.raw, context.env.DELIVERY_SIGN_SECRET)) return;
		const file = servedFile(context);
		if (!file) return;
		context.res = countedBody(context.res, (bytes) => {
			context.executionCtx.waitUntil(Promise.resolve(sink.record({ at, status, bytes, ...file }, context)));
		});
	});
	return { name: "usage-log", middleware: { afterAuth: [record] } };
}
