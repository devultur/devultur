import { describe, expect, it } from "vitest";
import { createWebhookEvent } from "./lifecycle-events";
import { type MediaEvent, MediaEventName } from "./types";
import { authenticateWebhook, handleWebhook, WebhookAuthError } from "./webhook";
import { signWebhook } from "./webhook-signature";

const RECORD_ID = "video-record";

const transcodeComplete: MediaEvent = {
	event: MediaEventName.TRANSCODE_COMPLETE,
	videoId: "vid1",
	duration: 12,
	playlistKey: "master.m3u8",
	thumbnailKey: "thumb.jpg",
};

/** One media record behind the `read` / `patch` callbacks; a field patched to `undefined` is removed. */
function recordStore(initial: Record<string, unknown>) {
	const record: Record<string, unknown> = { ...initial };
	let isRemoved = false;
	return {
		record,
		isRemoved: () => isRemoved,
		remove: async () => {
			isRemoved = true;
		},
		read: async () => (isRemoved ? null : record),
		patch: async (_id: string, fields: Record<string, unknown>) => {
			for (const [name, value] of Object.entries(fields)) {
				if (value === undefined) delete record[name];
				else record[name] = value;
			}
		},
	};
}

describe("handleWebhook", () => {
	it("moves a video transcoded without captions straight to ready", async () => {
		const store = recordStore({ transcodeStatus: "transcoding" });

		await handleWebhook({ event: transcodeComplete, recordId: RECORD_ID, ...store });

		expect(store.record).toMatchObject({ transcodeStatus: "ready", playlistUrl: "master.m3u8", duration: 12 });
	});

	it("waits in captioning while requested captions are pending, then becomes ready", async () => {
		const store = recordStore({ transcodeStatus: "transcoding", captionsPending: true });

		await handleWebhook({ event: transcodeComplete, recordId: RECORD_ID, ...store });
		expect(store.record.transcodeStatus).toBe("captioning");

		const captionsComplete: MediaEvent = { event: MediaEventName.CAPTIONS_COMPLETE, videoId: "vid1", locales: ["en"] };
		await handleWebhook({ event: captionsComplete, recordId: RECORD_ID, ...store });
		expect(store.record).toMatchObject({ transcodeStatus: "ready", captionsPending: false, captionLocales: ["en"] });
	});

	it("becomes ready when the captions arrived before the transcode completed", async () => {
		const store = recordStore({ transcodeStatus: "transcoding", captionsPending: true });

		const captionsComplete: MediaEvent = { event: MediaEventName.CAPTIONS_COMPLETE, videoId: "vid1", locales: ["en"] };
		await handleWebhook({ event: captionsComplete, recordId: RECORD_ID, ...store });
		await handleWebhook({ event: transcodeComplete, recordId: RECORD_ID, ...store });

		expect(store.record).toMatchObject({ transcodeStatus: "ready", captionLocales: ["en"] });
	});
});

const changedAt = (iso: string, lock: { hold: boolean }) =>
	createWebhookEvent(
		"media.changed",
		{ key: "private/image/img1/a.jpg", mediaId: "img1", changes: ["hold"], lock, etag: "e1" },
		new Date(iso),
	);

describe("handleWebhook with lifecycle events", () => {
	it("removes the record on media.deleted", async () => {
		const store = recordStore({});
		const event = createWebhookEvent("media.deleted", {
			key: "private/image/img1/a.jpg",
			mediaId: "img1",
			kind: "image",
			visibility: "private",
			reason: "api",
		});

		await handleWebhook({ event, recordId: RECORD_ID, ...store });

		expect(store.isRemoved()).toBe(true);
	});

	it("patches the lock on media.changed and ignores an older one arriving after it", async () => {
		const store = recordStore({});

		await handleWebhook({ event: changedAt("2030-01-01T00:00:02Z", { hold: true }), recordId: RECORD_ID, ...store });
		await handleWebhook({ event: changedAt("2030-01-01T00:00:01Z", { hold: false }), recordId: RECORD_ID, ...store });

		expect(store.record).toMatchObject({
			lock: { hold: true },
			etag: "e1",
			lifecycleEventAt: "2030-01-01T00:00:02.000Z",
		});
	});

	it("unwraps a transcode event sent in the envelope", async () => {
		const store = recordStore({ transcodeStatus: "transcoding" });

		await handleWebhook({
			event: createWebhookEvent("transcode.complete", transcodeComplete),
			recordId: RECORD_ID,
			...store,
		});

		expect(store.record.transcodeStatus).toBe("ready");
	});
});

describe("authenticateWebhook", () => {
	const SIGNING_SECRET = "whsec_c2lnbmluZy1zZWNyZXQtZm9yLXRlc3Rz";
	const event = createWebhookEvent("media.changed", {
		key: "public/file/f1/doc.pdf",
		mediaId: "f1",
		changes: ["replaced"],
		etag: "e2",
	});
	const body = JSON.stringify(event);

	it("returns the envelope of a signed webhook", async () => {
		const headers = await signWebhook({ id: event.id, payload: body, secret: SIGNING_SECRET });

		await expect(authenticateWebhook(body, { signingSecret: SIGNING_SECRET, headers })).resolves.toEqual(event);
	});

	it("refuses a signed webhook whose signature doesn't verify", async () => {
		const headers = await signWebhook({ id: event.id, payload: body, secret: "another-secret" });

		await expect(authenticateWebhook(body, { signingSecret: SIGNING_SECRET, headers })).rejects.toThrow(
			WebhookAuthError,
		);
	});

	it("needs the raw body to verify a signature", async () => {
		const headers = await signWebhook({ id: event.id, payload: body, secret: SIGNING_SECRET });

		await expect(authenticateWebhook(event, { signingSecret: SIGNING_SECRET, headers })).rejects.toThrow("raw body");
	});

	it("still accepts the bearer of a job callback when a signing secret is set", async () => {
		const result = await authenticateWebhook(JSON.stringify(transcodeComplete), {
			authorization: "Bearer worker-secret",
			secret: "worker-secret",
			signingSecret: SIGNING_SECRET,
		});

		expect(result).toEqual(transcodeComplete);
	});

	it("reads the bearer from the headers", async () => {
		const headers = new Headers({ Authorization: "Bearer worker-secret" });

		await expect(authenticateWebhook(transcodeComplete, { secret: "worker-secret", headers })).resolves.toEqual(
			transcodeComplete,
		);
	});

	it("refuses a signed webhook when only the bearer secret is configured", async () => {
		const headers = await signWebhook({ id: event.id, payload: body, secret: SIGNING_SECRET });

		await expect(authenticateWebhook(body, { secret: "worker-secret", headers })).rejects.toThrow(WebhookAuthError);
	});
});
