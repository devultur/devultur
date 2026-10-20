// Test support: a `createWorker()` over in-memory buckets with one locked video (`vid1`: a compliance-retained raw, a
// caption and an MP4), authenticated with the Worker secret. `settle()` waits for the work run after the response
// (audit records).
import { memoryBucket } from "../exports-test-harness";
import { createWorker } from "../index";
import type { WorkerPlugin } from "../plugin";
import { defaultPlugins } from "../plugins";
import { WORKER_SECRETS, withWorkerAuth } from "../plugins/worker-secret-auth-test-env";
import type { WorkerConfig } from "../request-state";

export const RAW_KEY = "private/video/vid1/raw/clip.mp4";
export const CAPTION_KEY = "private/video/vid1/captions/en.vtt";
export const MP4_KEY = "private/video/vid1/mp4/main-720p.mp4";
export const RAW_UNTIL = "2999-01-01T00:00:00Z";

export function lockedFixture(options: { plugins?: WorkerPlugin[]; config?: WorkerConfig } = {}) {
	const mediaBucket = memoryBucket();
	const keysBucket = memoryBucket();
	const kv = new Map<string, string>();
	const lock = JSON.stringify({ retention: { mode: "compliance", until: RAW_UNTIL }, hold: false });
	mediaBucket.objects.set(RAW_KEY, { bytes: new Uint8Array(4), httpMetadata: {}, customMetadata: { lock } });
	mediaBucket.objects.set(CAPTION_KEY, { bytes: new Uint8Array(4), httpMetadata: {}, customMetadata: {} });
	mediaBucket.objects.set(MP4_KEY, { bytes: new Uint8Array(4), httpMetadata: {}, customMetadata: {} });
	keysBucket.objects.set(`${RAW_KEY}/key-1`, { bytes: new Uint8Array(4), httpMetadata: {}, customMetadata: {} });
	const env = {
		...WORKER_SECRETS,
		DELIVERY_SIGN_SECRET: "delivery",
		MEDIA_BUCKET: mediaBucket,
		KEYS_BUCKET: keysBucket,
		MEDIA_KV: {
			get: async (key: string, type?: string) => {
				const value = kv.get(key) ?? null;
				return type === "json" && value ? JSON.parse(value) : value;
			},
			put: async (key: string, value: string) => void kv.set(key, value),
			delete: async (key: string) => void kv.delete(key),
		},
	};
	const app = createWorker({ plugins: [...defaultPlugins(options.config), ...(options.plugins ?? [])] });
	const waits: Promise<unknown>[] = [];
	const executionCtx = { waitUntil: (task: Promise<unknown>) => void waits.push(task), passThroughOnException() {} };
	const send = (path: string, init?: RequestInit) =>
		app.request(`https://media.example${path}`, withWorkerAuth(init), env as never, executionCtx as never);
	const settle = () => Promise.all(waits.splice(0));
	const isIntact = () => mediaBucket.objects.has(RAW_KEY) && keysBucket.objects.has(`${RAW_KEY}/key-1`);
	return { app, env, executionCtx, send, settle, kv, mediaBucket, keysBucket, isIntact };
}

export type LockedFixture = ReturnType<typeof lockedFixture>;
