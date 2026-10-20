import { describe, expect, it } from "vitest";
import { type MediaEvent, MediaEventName } from "./types";
import { handleWebhook } from "./webhook";

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
	return {
		record,
		read: async () => record,
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
