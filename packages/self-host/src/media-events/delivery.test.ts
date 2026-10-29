import { createWebhookEvent, verifyWebhookSignature } from "@devultur/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerEnv } from "../types";
import { deliverWebhooks, MAX_WEBHOOK_ATTEMPTS, readDeliveryRecord, type WebhookMessage } from "./delivery";
import { sendMediaEvents } from "./emit";
import { resolveWebhookTarget, unsafeUrlReason } from "./target";

const URL = "https://hooks.example.com/media";
const SECRET = "delivery-test-secret";

const event = createWebhookEvent("media.deleted", {
	key: "public/file/f1/doc.pdf",
	mediaId: "f1",
	kind: "file",
	visibility: "public",
	reason: "api",
});
const message: WebhookMessage = { event, target: { url: URL, secrets: [SECRET] } };

function queueMessage(attempts: number) {
	return { id: "m1", timestamp: new Date(), body: message, attempts, ack: vi.fn(), retry: vi.fn() };
}

function memoryKv() {
	const values = new Map<string, string>();
	return {
		get: async (key: string, type?: string) => {
			const value = values.get(key) ?? null;
			return type === "json" && value ? JSON.parse(value) : value;
		},
		put: async (key: string, value: string) => void values.set(key, value),
	};
}

function envWith(extra: Partial<WorkerEnv> = {}) {
	return { MEDIA_KV: memoryKv() as unknown as KVNamespace, ...extra } as WorkerEnv;
}

const batchOf = (...messages: ReturnType<typeof queueMessage>[]) =>
	({ queue: "media-webhooks", messages }) as unknown as MessageBatch<WebhookMessage>;

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

describe("deliverWebhooks (queue consumer)", () => {
	it("acks a delivered event and logs it", async () => {
		const env = envWith();
		const queued = queueMessage(1);

		await deliverWebhooks(batchOf(queued), env);

		expect(queued.ack).toHaveBeenCalled();
		expect(await readDeliveryRecord(env.MEDIA_KV, event.id)).toMatchObject({
			eventId: event.id,
			type: "media.deleted",
			status: "delivered",
			attempts: 1,
			responseStatus: 200,
		});
	});

	it("signs every attempt again (a retry hours later still verifies)", async () => {
		const env = envWith();

		await deliverWebhooks(batchOf(queueMessage(3)), env);

		const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
		const verification = await verifyWebhookSignature({
			payload: String(init.body),
			headers: init.headers as Record<string, string>,
			secret: SECRET,
		});
		expect(verification).toMatchObject({ ok: true, id: event.id });
		expect(init.redirect).toBe("manual");
	});

	it("retries a failed attempt after 30 s, 2 min, 10 min, 1 h, then 6 h", async () => {
		status = 503;
		const env = envWith();
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
		const env = envWith({ WEBHOOK_DLQ: dlq as unknown as Queue<WebhookMessage> });
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

		await deliverWebhooks(batchOf(queued), envWith());

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
		const env = envWith();
		const queued = queueMessage(1);

		await deliverWebhooks(batchOf(queued), env);

		expect(queued.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
		expect(await readDeliveryRecord(env.MEDIA_KV, event.id)).toMatchObject({ error: "connection reset" });
	});
});

describe("sendMediaEvents", () => {
	it("queues the events when WEBHOOK_QUEUE is bound", async () => {
		const queue = { sendBatch: vi.fn(async () => {}) };
		const env = envWith({
			MEDIA_WEBHOOK_URL: URL,
			MEDIA_WEBHOOK_SECRET: SECRET,
			WEBHOOK_QUEUE: queue as unknown as Queue<WebhookMessage>,
		});

		await sendMediaEvents(env, [event]);

		expect(queue.sendBatch).toHaveBeenCalledWith([{ body: { event, target: { url: URL, secrets: [SECRET] } } }]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("makes one attempt without a queue, and logs a failure", async () => {
		status = 500;
		const env = envWith({ MEDIA_WEBHOOK_URL: URL, MEDIA_WEBHOOK_SECRET: SECRET });

		await sendMediaEvents(env, [event]);

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(await readDeliveryRecord(env.MEDIA_KV, event.id)).toMatchObject({ status: "failed", attempts: 1 });
	});

	it("never sends to an unsafe URL", async () => {
		const env = envWith({ MEDIA_WEBHOOK_URL: "https://169.254.169.254/latest", MEDIA_WEBHOOK_SECRET: SECRET });

		await sendMediaEvents(env, [event]);

		expect(fetch).not.toHaveBeenCalled();
	});

	it("sends to http on localhost when the opt-out is set", async () => {
		const env = envWith({
			MEDIA_WEBHOOK_URL: "http://localhost:3000/hooks",
			MEDIA_WEBHOOK_SECRET: SECRET,
			MEDIA_WEBHOOK_ALLOW_UNSAFE_URL: "true",
		});

		await sendMediaEvents(env, [event]);

		expect(fetch).toHaveBeenCalledWith("http://localhost:3000/hooks", expect.anything());
	});
});

describe("resolveWebhookTarget", () => {
	const env = {
		MEDIA_WEBHOOK_URL: URL,
		MEDIA_WEBHOOK_SECRET: "old-secret new-secret",
		MEDIA_WEBHOOK_EVENTS: "media.deleted, transcode.complete",
	};

	it("reads the vars, with space-separated secrets during a rotation", () => {
		expect(resolveWebhookTarget(undefined, env)).toEqual({
			url: URL,
			secrets: ["old-secret", "new-secret"],
			events: ["media.deleted", "transcode.complete"],
			allowUnsafeUrl: false,
		});
	});

	it("lets the scope's config override the vars", () => {
		const target = resolveWebhookTarget({ webhooks: { url: "https://scope.example.com/h", secret: "s" } }, env);

		expect(target).toEqual({
			url: "https://scope.example.com/h",
			secrets: ["s"],
			events: ["media.deleted", "media.changed"],
			allowUnsafeUrl: false,
		});
	});

	it("is none without a secret", () => {
		expect(resolveWebhookTarget({ webhooks: { url: URL, secret: [] } }, {})).toBeNull();
		expect(resolveWebhookTarget(undefined, { MEDIA_WEBHOOK_URL: URL })).toBeNull();
	});
});

describe("unsafeUrlReason (SSRF guard)", () => {
	it.each([
		"https://hooks.example.com/media",
		"https://8.8.8.8/hooks",
		"https://[2606:4700::1111]/hooks",
	])("accepts %s", (url) => {
		expect(unsafeUrlReason(url)).toBeNull();
	});

	it.each([
		["http://hooks.example.com/media", "not https"],
		["https://localhost/hooks", "a private or loopback host"],
		["https://api.localhost/hooks", "a private or loopback host"],
		["https://127.0.0.1/hooks", "a private or loopback host"],
		["https://2130706433/hooks", "a private or loopback host"],
		["https://10.1.2.3/hooks", "a private or loopback host"],
		["https://172.20.0.1/hooks", "a private or loopback host"],
		["https://192.168.1.10/hooks", "a private or loopback host"],
		["https://169.254.169.254/latest/meta-data", "a private or loopback host"],
		["https://100.64.0.1/hooks", "a private or loopback host"],
		["https://0.0.0.0/hooks", "a private or loopback host"],
		["https://[::1]/hooks", "a private or loopback host"],
		["https://[fd00::1]/hooks", "a private or loopback host"],
		["https://[fe80::1]/hooks", "a private or loopback host"],
		["https://[::ffff:10.0.0.1]/hooks", "a private or loopback host"],
		["https://intranet/hooks", "a private or loopback host"],
		["https://metadata.internal/hooks", "a private or loopback host"],
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
