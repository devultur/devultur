import { verifyWebhookSignature, type WebhookEvent } from "@devultur/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KvPrefix } from "../helpers";
import { lockedFixture, RAW_KEY } from "../object-lock/worker-fixture";
import type { WorkerPlugin } from "../plugin";
import type { WorkerConfig } from "../request-state";
import { sniffableBytes } from "../test-fixtures";

// Every route that deletes or changes stored media emits its event once, signed to the configured webhook.
const WEBHOOK_URL = "https://hooks.example.com/media";
const SECRET = "whsec_bWVkaWEtZXZlbnRzLXRlc3Qtc2VjcmV0";
const config: WorkerConfig = { webhooks: { url: WEBHOOK_URL, secret: SECRET } };

const IMAGE_KEY = "public/image/img1/photo.jpg";
const FREE_RAW_KEY = "private/video/vid2/raw/clip.mp4";

let received: { event: WebhookEvent; isSigned: boolean }[];

beforeEach(() => {
	received = [];
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		expect(url).toBe(WEBHOOK_URL);
		const payload = String(init.body);
		const verification = await verifyWebhookSignature({ payload, headers: init.headers as never, secret: SECRET });
		received.push({ event: JSON.parse(payload), isSigned: verification.ok });
		return new Response(null, { status: 204 });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function fixtureWith(options: { plugins?: WorkerPlugin[] } = {}) {
	const fixture = lockedFixture({ config, ...options });
	const put = (key: string) =>
		fixture.mediaBucket.objects.set(key, { bytes: new Uint8Array(4), httpMetadata: {}, customMetadata: {} });
	put(IMAGE_KEY);
	put(FREE_RAW_KEY);
	put("private/video/vid2/hls/playlist.m3u8");
	return { ...fixture, put };
}

const eventsOf = () => received.map(({ event }) => ({ type: event.type, data: event.data }));

describe("media events of the routes", () => {
	it("a video delete is one signed media.deleted for its folder", async () => {
		const fixture = fixtureWith();

		const response = await fixture.send("/v1/media/videos/vid2", { method: "DELETE" });
		await fixture.settle();

		expect(response.status).toBe(200);
		expect(received).toHaveLength(1);
		expect(received[0].isSigned).toBe(true);
		expect(received[0].event).toMatchObject({ id: expect.stringMatching(/^evt_/), apiVersion: 1 });
		expect(eventsOf()).toEqual([
			{
				type: "media.deleted",
				data: { key: "private/video/vid2", mediaId: "vid2", kind: "video", visibility: "private", reason: "api" },
			},
		]);
	});

	it("a video delete that found nothing sends nothing", async () => {
		const fixture = fixtureWith();

		await fixture.send("/v1/media/videos/missing", { method: "DELETE" });
		await fixture.settle();

		expect(received).toEqual([]);
	});

	it("a delete a lock refuses sends nothing", async () => {
		const fixture = fixtureWith();

		const videoDelete = await fixture.send("/v1/media/videos/vid1", { method: "DELETE" });
		const keyDelete = await fixture.send(`/v1/media/${RAW_KEY}`, { method: "DELETE" });
		await fixture.settle();

		expect([videoDelete.status, keyDelete.status]).toEqual([409, 409]);
		expect(received).toEqual([]);
	});

	it("a key delete is a media.deleted of the image", async () => {
		const fixture = fixtureWith();

		const response = await fixture.send(`/v1/media/${IMAGE_KEY}`, { method: "DELETE" });
		await fixture.settle();

		expect(response.status).toBe(204);
		expect(eventsOf()).toEqual([
			{
				type: "media.deleted",
				data: { key: IMAGE_KEY, mediaId: "img1", kind: "image", visibility: "public", reason: "api" },
			},
		]);
	});

	it("a key delete of an asset uses its key as the media id", async () => {
		const fixture = fixtureWith();
		fixture.put("private/asset/exports/report.zip");

		await fixture.send("/v1/media/private/asset/exports/report.zip", { method: "DELETE" });
		await fixture.settle();

		expect(eventsOf()).toEqual([
			{
				type: "media.deleted",
				data: {
					key: "private/asset/exports/report.zip",
					mediaId: "private/asset/exports/report.zip",
					kind: "asset",
					visibility: "private",
					reason: "api",
				},
			},
		]);
	});

	it("deleting a video's original by key is original-deleted, and one of its outputs is no event", async () => {
		const fixture = fixtureWith();
		const etag = (await fixture.mediaBucket.head(FREE_RAW_KEY))?.etag;

		await fixture.send(`/v1/media/${FREE_RAW_KEY}`, { method: "DELETE" });
		await fixture.send("/v1/media/private/video/vid2/hls/playlist.m3u8", { method: "DELETE" });
		await fixture.settle();

		expect(eventsOf()).toEqual([
			{ type: "media.changed", data: { key: FREE_RAW_KEY, mediaId: "vid2", changes: ["original-deleted"], etag } },
		]);
	});

	it("a lock change is a media.changed with the new lock; a refused one is none", async () => {
		const fixture = fixtureWith();
		const until = "2999-06-01T00:00:00Z";

		const applied = await fixture.send(`/v1/lock/${IMAGE_KEY}`, {
			method: "PUT",
			body: JSON.stringify({ mode: "governance", until }),
		});
		const refused = await fixture.send(`/v1/lock/${RAW_KEY}`, {
			method: "PUT",
			body: JSON.stringify({ remove: true }),
		});
		await fixture.settle();

		expect([applied.status, refused.status]).toEqual([200, 409]);
		expect(eventsOf()).toEqual([
			{
				type: "media.changed",
				data: {
					key: IMAGE_KEY,
					mediaId: "img1",
					changes: ["lock"],
					lock: { retention: { mode: "governance", until, derivatives: "inherit" }, hold: false },
					etag: (await fixture.mediaBucket.head(IMAGE_KEY))?.etag,
				},
			},
		]);
	});

	it("a hold is a media.changed per object it changed", async () => {
		const fixture = fixtureWith();

		await fixture.send("/v1/lock/hold", {
			method: "POST",
			body: JSON.stringify({ hold: true, keys: [IMAGE_KEY, "public/image/missing/x.jpg"] }),
		});
		await fixture.settle();

		expect(eventsOf()).toEqual([
			{
				type: "media.changed",
				data: {
					key: IMAGE_KEY,
					mediaId: "img1",
					changes: ["hold"],
					lock: { hold: true },
					etag: expect.any(String),
				},
			},
		]);
	});

	it("an overwrite is a media.changed with replaced and the new etag; a first write is none", async () => {
		const fixture = fixtureWith();
		const write = (key: string) =>
			fixture.send(`/v1/upload/${key}`, {
				method: "PUT",
				headers: { "Content-Type": "image/jpeg" },
				body: sniffableBytes("image/jpeg", 32),
			});

		const overwrite = await write(IMAGE_KEY);
		const created = await write("public/image/img9/new.jpg");
		await fixture.settle();

		expect([overwrite.status, created.status]).toEqual([200, 200]);
		const etag = (await fixture.mediaBucket.head(IMAGE_KEY))?.etag;
		expect(eventsOf()).toEqual([
			{ type: "media.changed", data: { key: IMAGE_KEY, mediaId: "img1", changes: ["replaced"], etag } },
		]);
	});

	it("deleting the original after a transcode is original-deleted, sent to the webhook of the launching scope", async () => {
		const fixture = fixtureWith();
		const etag = (await fixture.mediaBucket.head(FREE_RAW_KEY))?.etag;
		const launchUrl = "https://launcher.example.com/hooks";
		fixture.kv.set(
			`${KvPrefix.TRANSCODE_RAW}:vid2`,
			JSON.stringify({ storageKey: FREE_RAW_KEY, deleteOnComplete: true }),
		);
		fixture.kv.set(
			"webhook-target:vid2",
			JSON.stringify({ url: launchUrl, secrets: [SECRET], events: ["media.changed"], allowUnsafeUrl: false }),
		);
		const urls: string[] = [];
		const fetchMock = vi.fn(async (url: string) => {
			urls.push(url);
			return new Response(null, { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		await fixture.send("/v1/webhooks/transcode", {
			method: "POST",
			body: JSON.stringify({ event: "transcode.complete", videoId: "vid2", duration: 1 }),
		});
		await fixture.settle();

		expect(fixture.mediaBucket.objects.has(FREE_RAW_KEY)).toBe(false);
		expect(urls).toEqual([launchUrl]);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(String(init.body))).toMatchObject({
			type: "media.changed",
			data: { key: FREE_RAW_KEY, mediaId: "vid2", changes: ["original-deleted"], etag },
		});
	});

	it("fans transcode events out only to an endpoint that opted in", async () => {
		const optedIn = lockedFixture({ config: { webhooks: { ...config.webhooks!, events: ["transcode.complete"] } } });
		const fixture = fixtureWith();
		const complete = { event: "transcode.complete", videoId: "vid3", duration: 1 };

		for (const { send, settle } of [fixture, optedIn]) {
			await send("/v1/webhooks/transcode", { method: "POST", body: JSON.stringify(complete) });
			await settle();
		}

		expect(eventsOf()).toEqual([{ type: "transcode.complete", data: expect.objectContaining(complete) }]);
	});

	it("sends nothing without a webhook configured", async () => {
		const fixture = lockedFixture();

		await fixture.send("/v1/media/videos/vid2", { method: "DELETE" });
		await fixture.settle();

		expect(received).toEqual([]);
	});
});

describe("onMediaEvent", () => {
	it("replaces the built-in delivery: the hook gets the event, the webhook nothing", async () => {
		const seen: WebhookEvent[] = [];
		const plugin: WorkerPlugin = { name: "events", onMediaEvent: (_context, event) => void seen.push(event) };
		const fixture = fixtureWith({ plugins: [plugin] });

		await fixture.send(`/v1/media/${IMAGE_KEY}`, { method: "DELETE" });
		await fixture.settle();

		expect(received).toEqual([]);
		expect(seen.map((event) => event.type)).toEqual(["media.deleted"]);
	});

	it("runs without any webhook configured, and a failing hook doesn't fail the request", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const seen: string[] = [];
		const plugins: WorkerPlugin[] = [
			{ name: "failing", onMediaEvent: () => Promise.reject(new Error("down")) },
			{ name: "events", onMediaEvent: (_context, event) => void seen.push(event.type) },
		];
		const fixture = lockedFixture({ plugins });
		fixture.mediaBucket.objects.set(IMAGE_KEY, { bytes: new Uint8Array(4), httpMetadata: {}, customMetadata: {} });

		const response = await fixture.send(`/v1/media/${IMAGE_KEY}`, { method: "DELETE" });
		await fixture.settle();

		expect(response.status).toBe(204);
		expect(seen).toEqual(["media.deleted"]);
	});
});
