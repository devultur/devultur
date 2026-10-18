import { isBearerOf } from "./bearer";
import { type MediaEvent, MediaEventName, MediaStatus } from "./types";

type PatchFn = (id: string, fields: Record<string, unknown>) => Promise<void>;
type ReadFn = (id: string) => Promise<Record<string, unknown> | null>;

interface HandleWebhookOptions {
	event: MediaEvent;
	recordId: string;
	patch: PatchFn;
	read: ReadFn;
}

export async function handleWebhook({ event, recordId, patch, read }: HandleWebhookOptions): Promise<void> {
	switch (event.event) {
		case MediaEventName.TRANSCODE_STARTED:
			await patch(recordId, {
				transcodeStatus: MediaStatus.TRANSCODING,
				transcodeProgress: { current: 0, total: event.totalSegments },
				transcodeError: undefined,
				duration: event.duration,
			});
			break;

		case MediaEventName.TRANSCODE_PROGRESS:
			await patch(recordId, {
				transcodeProgress: { current: event.currentSegment, total: event.totalSegments, phase: event.phase },
			});
			break;

		case MediaEventName.TRANSCODE_COMPLETE: {
			const record = await read(recordId);
			const hasCaptions = ((record?.captionLocales as string[] | undefined)?.length ?? 0) > 0;
			await patch(recordId, {
				transcodeStatus: hasCaptions ? MediaStatus.READY : MediaStatus.CAPTIONING,
				transcodeProgress: undefined,
				duration: event.duration,
				playlistUrl: event.playlistKey,
				thumbnailKey: event.thumbnailKey,
				// Preset outputs (MP4, variants, poster): only come with config presets or inline specs.
				...(event.renditions ? { renditions: event.renditions } : {}),
				...(event.posterUrls ? { posterUrls: event.posterUrls } : {}),
				...(event.hasAudio !== undefined ? { hasAudio: event.hasAudio } : {}),
				...(event.storyboardKey ? { storyboardKey: event.storyboardKey } : {}),
			});
			break;
		}

		case MediaEventName.CAPTIONS_COMPLETE: {
			const record = await read(recordId);
			const hasPlaylist = !!record?.playlistUrl;
			await patch(recordId, {
				transcodeStatus: hasPlaylist ? MediaStatus.READY : MediaStatus.TRANSCODING,
				captionLocales: event.locales,
			});
			break;
		}

		case MediaEventName.TRANSCODE_FAILED:
		case MediaEventName.CAPTIONS_FAILED:
			await patch(recordId, {
				transcodeStatus: MediaStatus.FAILED,
				transcodeError: event.error,
				transcodeProgress: undefined,
			});
			break;
	}
}

export function createHTTPWebhookHandler(options: { secret: string }) {
	return {
		handler: async (_ctx: unknown, request: Request) => {
			if (!isBearerOf(request.headers.get("Authorization"), options.secret)) {
				return new Response("Unauthorized", { status: 401 });
			}
			const event = (await request.json()) as MediaEvent;
			return { event };
		},
	};
}
