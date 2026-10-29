import { createWebhookEvent, verifyWebhookSignature } from "@devultur/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { staticConfig } from "../plugins";
import type { WorkerEnv } from "../types";
import {
	createWebhookConsumer,
	deliverWebhooks,
	MAX_WEBHOOK_ATTEMPTS,
	readDeliveryRecord,
	type WebhookMessage,
} from "./delivery";
import { MAX_DIRECT_DELIVERIES, sendMediaEvents } from "./emit";
import { rememberJobTarget } from "./job-target";
import { toWebhookTarget, unsafeUrlReason, webhookTargetOf } from "./target";

const URL = "https://hooks.example.com/media";
const SECRET = "delivery-test-secret";
const NEW_SECRET = "delivery-test-secret-rotated";

const event = createWebhookEvent("media.deleted", {
	key: "public/file/f1/doc.pdf",
	mediaId: "f1",
	kind: "file",
	visibility: "public",
	reason: "api",
});
const message: WebhookMessage = { event, scope: "env" };

function queueMessage(attempts: number, body: WebhookMessage = message) {
	return { id: "m1", timestamp: new Date(), body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function memoryKv() {
	const values = new Map<string, string>();
	return {
		values,
		get: async (key: string, type?: string) => {
			const value = values.get(key) ?? null;
			return type === "json" && value ? JSON.parse(value) : value;
		},
		put: async (key: string, value: string) => void values.set(key, value),
		delete: async (key: string) => void values.delete(key),
	};
}

function envWith(extra: Partial<WorkerEnv> = {}) {
	const kv = memoryKv();
	const env = {
		MEDIA_KV: kv as unknown as KVNamespace,
		MEDIA_WEBHOOK_URL: URL,
		MEDIA_WEBHOOK_SECRET: SECRET,
		...extra,
	} as WorkerEnv;
	return { env, kv };
}

const batchOf = (...messages: ReturnType<typeof queueMessage>[]) =>
	({ queue: "media-webhooks", messages }) as unknown as MessageBatch<WebhookMessage>;

/** Whether each request made so far verifies against `secret`. */
async function signedWith(secret: string) {
	return Promise.all(
		vi.mocked(fetch).mock.calls.map(async ([, init]) => {
			const request = init as RequestInit;
			const verification = await verifyWebhookSignature({
				payload: String(request.body),
				headers: request.headers as Record<string, string>,
				secret,
			});
			return verification.ok;
		}),
	);
}

let status: number;

beforeEach(() => {
	status = 200;
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status })),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("the queue consumer", () => {
	it("acks a delivered event and logs it", async () => {
		const { env } = envWith();
		const queued = queueMessage(1);

		await deliverWebhooks(batchOf(queued), env);

		expect(queued.ack).toHaveBeenCalled();
		expect(await readDeliveryRecord(env.MEDIA_KV, event.id)).toMatchObject({
			eventId: event.id,
			type: "media.deleted",
			scope: "env",
			url: URL,
			status: "delivered",
			attempts: 1,
			responseStatus: 200,
		});
	});

	it("signs every attempt again, without following redirects", async () => {
		const { env } = envWith();

		await deliverWebhooks(batchOf(queueMessage(3)), env);

		expect(await signedWith(SECRET)).toEqual([true]);
		const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
		expect(init.redirect).toBe("manual");
	});

	it("signs a message queued before a rotation with the secret in force at delivery", async () => {
		const queue = { sendBatch: vi.fn(async (_messages: { body: WebhookMessage }[]) => {}) };
		const { env } = envWith({ WEBHOOK_QUEUE: queue as unknown as Queue<WebhookMessage> });
		await sendMediaEvents(env, [event]);
		const [queued] = queue.sendBatch.mock.calls[0][0];

		env.MEDIA_WEBHOOK_SECRET = NEW_SECRET;
		await deliverWebhooks(batchOf(queueMessage(1, queued.body)), env);

		expect(await signedWith(NEW_SECRET)).toEqual([true]);
		expect(await signedWith(SECRET)).toEqual([false]);
	});

	it("resolves a config scope through the plugins it was created with", async () => {
		const plugins = [staticConfig({ webhooks: { url: "https://scope.example.com/h", secret: NEW_SECRET } })];
		const consumer = createWebhookConsumer({ plugins });
		const { env } = envWith();

		await consumer(batchOf(queueMessage(1, { event, scope: "config" })), env);

		expect(fetch).toHaveBeenCalledWith("https://scope.example.com/h", expect.anything());
		expect(await signedWith(NEW_SECRET)).toEqual([true]);
	});

	it("drops a message whose scope no longer resolves", async () => {
		const { env } = envWith();
		const queued = queueMessage(1, { event, scope: "removed-scope" });

		await deliverWebhooks(batchOf(queued), env);

		expect(fetch).not.toHaveBeenCalled();
		expect(queued.ack).toHaveBeenCalled();
		expect(await readDeliveryRecord(env.MEDIA_KV, event.id)).toMatchObject({ status: "undeliverable" });
	});

	it("retries a failed attempt after 30 s, 2 min, 10 min, 1 h, then 6 h", async () => {
		status = 503;
		const { env } = envWith();
		const delays: number[] = [];

		for (let attempt = 1; attempt < MAX_WEBHOOK_ATTEMPTS; attempt++) {
			const queued = queueMessage(attempt);
			await deliverWebhooks(batchOf(queued), env);
			expect(queued.ack).not.toHaveBeenCalled();
			delays.push(queued.retry.mock.calls[0][0].delaySeconds);
		}

		expect(delays).toEqual([30, 120, 600, 3600, 21600, 21600, 21600]);
		expect(await readDeliveryRecord(env.MEDIA_KV, event.id)).toMatchObject({
			status: "retrying",
			attempts: 7,
			responseStatus: 503,
			error: "HTTP 503",
		});
	});

	it("sends the event to WEBHOOK_DLQ after the 8th attempt", async () => {
		status = 500;
		const dlq = { send: vi.fn(async () => {}) };
		const { env } = envWith({ WEBHOOK_DLQ: dlq as unknown as Queue<WebhookMessage> });
		const queued = queueMessage(MAX_WEBHOOK_ATTEMPTS);

		await deliverWebhooks(batchOf(queued), env);

		expect(dlq.send).toHaveBeenCalledWith(message);
		expect(queued.ack).toHaveBeenCalled();
		expect(queued.retry).not.toHaveBeenCalled();
		expect(await readDeliveryRecord(env.MEDIA_KV, event.id)).toMatchObject({ status: "dead-lettered", attempts: 8 });
	});

	it("without WEBHOOK_DLQ, leaves the last failure to the queue's own dead-letter queue", async () => {
		status = 500;
		const queued = queueMessage(MAX_WEBHOOK_ATTEMPTS);

		await deliverWebhooks(batchOf(queued), envWith().env);

		expect(queued.retry).toHaveBeenCalledWith();
		expect(queued.ack).not.toHaveBeenCalled();
	});

	it("treats a network error as a failed attempt", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("connection reset");
			}),
		);
		const { env } = envWith();
		const queued = queueMessage(1);

		await deliverWebhooks(batchOf(queued), env);

		expect(queued.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
		expect(await readDeliveryRecord(env.MEDIA_KV, event.id)).toMatchObject({ error: "connection reset" });
	});
});

describe("secrets at rest", () => {
	it("are in no queue message, DLQ message, KV value or log line", async () => {
		status = 500;
		const queue = { sendBatch: vi.fn(async (_messages: unknown) => {}) };
		const dlq = { send: vi.fn(async (_message: unknown) => {}) };
		const { env, kv } = envWith({
			WEBHOOK_QUEUE: queue as unknown as Queue<WebhookMessage>,
			WEBHOOK_DLQ: dlq as unknown as Queue<WebhookMessage>,
		});
		const logged = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.mocked(console.error)];

		await sendMediaEvents(env, [event]);
		await deliverWebhooks(batchOf(queueMessage(MAX_WEBHOOK_ATTEMPTS)), env);
		await rememberJobTarget(env.MEDIA_KV, "vid1", webhookTargetOf(undefined, env));

		const stored = JSON.stringify([
			queue.sendBatch.mock.calls,
			dlq.send.mock.calls,
			[...kv.values.values()],
			logged.map((spy) => spy.mock.calls),
		]);
		expect(dlq.send).toHaveBeenCalled();
		expect(stored).not.toContain(SECRET);
		expect(kv.values.get("webhook-target:vid1")).toBe(JSON.stringify({ scope: "env" }));
	});
});

describe("sendMediaEvents", () => {
	it("queues the events by scope when WEBHOOK_QUEUE is bound", async () => {
		const queue = { sendBatch: vi.fn(async () => {}) };
		const { env } = envWith({ WEBHOOK_QUEUE: queue as unknown as Queue<WebhookMessage> });

		await sendMediaEvents(env, [event]);

		expect(queue.sendBatch).toHaveBeenCalledWith([{ body: { event, scope: "env" } }]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("makes one attempt without a queue, and logs a failure", async () => {
		status = 500;
		const { env } = envWith();

		await sendMediaEvents(env, [event]);

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(await readDeliveryRecord(env.MEDIA_KV, event.id)).toMatchObject({ status: "failed", attempts: 1 });
	});

	it("delivers at most MAX_DIRECT_DELIVERIES without a queue", async () => {
		const { env } = envWith();
		const events = Array.from({ length: MAX_DIRECT_DELIVERIES + 5 }, () =>
			createWebhookEvent("media.deleted", event.data),
		);

		await sendMediaEvents(env, events);

		expect(fetch).toHaveBeenCalledTimes(MAX_DIRECT_DELIVERIES);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("5 events"));
	});

	it("never sends to an unsafe URL", async () => {
		const { env } = envWith({ MEDIA_WEBHOOK_URL: "https://169.254.169.254/latest" });

		await sendMediaEvents(env, [event]);

		expect(fetch).not.toHaveBeenCalled();
	});

	it("sends to http on localhost when the opt-out is set", async () => {
		const { env } = envWith({
			MEDIA_WEBHOOK_URL: "http://localhost:3000/hooks",
			MEDIA_WEBHOOK_ALLOW_UNSAFE_URL: "true",
		});

		await sendMediaEvents(env, [event]);

		expect(fetch).toHaveBeenCalledWith("http://localhost:3000/hooks", expect.anything());
	});
});

describe("webhookTargetOf", () => {
	const env = {
		MEDIA_WEBHOOK_URL: URL,
		MEDIA_WEBHOOK_SECRET: "old-secret new-secret",
		MEDIA_WEBHOOK_EVENTS: "media.deleted, transcode.complete",
	};

	it("reads the vars, with space-separated secrets during a rotation", () => {
		expect(webhookTargetOf(undefined, env)).toEqual({
			scope: "env",
			url: URL,
			secrets: ["old-secret", "new-secret"],
			events: ["media.deleted", "transcode.complete"],
			allowUnsafeUrl: false,
		});
	});

	it("lets the scope's config override the vars", () => {
		const target = webhookTargetOf({ webhooks: { url: "https://scope.example.com/h", secret: "s" } }, env);

		expect(target).toEqual({
			scope: "config",
			url: "https://scope.example.com/h",
			secrets: ["s"],
			events: ["media.deleted", "media.changed"],
			allowUnsafeUrl: false,
		});
	});

	it("is none without a secret", () => {
		expect(toWebhookTarget({ url: URL, secret: [] })).toBeNull();
		expect(webhookTargetOf(undefined, { MEDIA_WEBHOOK_URL: URL })).toBeNull();
	});
});

const PRIVATE = "a private or special-purpose host";

describe("unsafeUrlReason (SSRF guard)", () => {
	it.each([
		"https://hooks.example.com/media",
		"https://8.8.8.8/hooks",
		"https://[2606:4700::1111]/hooks",
		"https://api.v2.example.com/hooks",
	])("accepts %s", (url) => {
		expect(unsafeUrlReason(url)).toBeNull();
	});

	it.each([
		["http://hooks.example.com/media", "not https"],
		["https://localhost/hooks", PRIVATE],
		["https://api.localhost/hooks", PRIVATE],
		["https://127.0.0.1/hooks", PRIVATE],
		["https://2130706433/hooks", PRIVATE],
		["https://10.1.2.3/hooks", PRIVATE],
		["https://172.20.0.1/hooks", PRIVATE],
		["https://192.168.1.10/hooks", PRIVATE],
		["https://169.254.169.254/latest/meta-data", PRIVATE],
		["https://100.64.0.1/hooks", PRIVATE],
		["https://0.0.0.0/hooks", PRIVATE],
		["https://192.0.2.1/hooks", PRIVATE],
		["https://203.0.113.9/hooks", PRIVATE],
		["https://[::1]/hooks", PRIVATE],
		["https://[::]/hooks", PRIVATE],
		["https://[::10.0.0.1]/hooks", PRIVATE],
		["https://[::8.8.8.8]/hooks", PRIVATE],
		["https://[::ffff:10.0.0.1]/hooks", PRIVATE],
		["https://[::ffff:8.8.8.8]/hooks", PRIVATE],
		["https://[64:ff9b::a00:1]/hooks", PRIVATE],
		["https://[64:ff9b:1::1]/hooks", PRIVATE],
		["https://[2002:a00:1::1]/hooks", PRIVATE],
		["https://[2001:0:4136:e378::1]/hooks", PRIVATE],
		["https://[2001:db8::1]/hooks", PRIVATE],
		["https://[100::1]/hooks", PRIVATE],
		["https://[fd00::1]/hooks", PRIVATE],
		["https://[fe80::1]/hooks", PRIVATE],
		["https://[fec0::1]/hooks", PRIVATE],
		["https://[ff02::1]/hooks", PRIVATE],
		["https://10.0.0.1.nip.io/hooks", PRIVATE],
		["https://app.192.168.1.1.sslip.io/hooks", PRIVATE],
		["https://intranet/hooks", PRIVATE],
		["https://metadata.internal/hooks", PRIVATE],
		["https://user:pass@hooks.example.com/", "credentials in the URL"],
		["ftp://hooks.example.com/", "not https"],
		["not a url", "not a valid URL"],
	])("refuses %s (%s)", (url, reason) => {
		expect(unsafeUrlReason(url)).toBe(reason);
	});

	it("allows http and private hosts only with the opt-out", () => {
		expect(unsafeUrlReason("http://127.0.0.1:8787/hooks", true)).toBeNull();
		expect(unsafeUrlReason("file:///etc/passwd", true)).toBe("not http(s)");
	});
});
