import { isBearerOf } from "./bearer";
import {
	isMediaLifecycleEvent,
	isNewerEvent,
	isWebhookEvent,
	type MediaLifecycleEvent,
	type WebhookEvent,
} from "./lifecycle-events";
import { type MediaEvent, MediaEventName, MediaStatus, type WebhookVerifyOptions } from "./types";
import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from "./webhook-signature";

type PatchFn = (id: string, fields: Record<string, unknown>) => Promise<void>;
type ReadFn = (id: string) => Promise<Record<string, unknown> | null>;
type RemoveFn = (id: string) => Promise<void>;

interface HandleWebhookOptions {
	/** A bare transcode or captions event, or an envelope (lifecycle, or a transcode or captions one). */
	event: MediaEvent | WebhookEvent;
	recordId: string;
	patch: PatchFn;
	read: ReadFn;
	/** Deletes the record, on `media.deleted`. Omitted: a `media.deleted` changes nothing. */
	remove?: RemoveFn;
}

/** Record field holding the `occurredAt` of the last lifecycle event applied to it (events arrive unordered). */
export const LIFECYCLE_EVENT_AT_FIELD = "lifecycleEventAt";

/**
 * Applies a media Worker event to your media record through `read` / `patch` (and `remove`).
 *
 * `transcode.complete` waits in "captioning" only when the record has `captionsPending: true` (set it when you
 * request captions); otherwise the video goes straight to "ready". `captions.complete` clears `captionsPending`.
 *
 * Lifecycle events: `media.deleted` removes the record; `media.changed` patches its `lock` and `etag`. One older than
 * the last one applied (the record's `lifecycleEventAt`) is ignored. Deduplicating by the event's `id` is the caller's.
 */
export async function handleWebhook(options: HandleWebhookOptions): Promise<void> {
	const { event } = options;
	if (isMediaLifecycleEvent(event)) return applyLifecycleEvent(event, options);
	const mediaEvent = isWebhookEvent(event) ? (event.data as MediaEvent) : (event as MediaEvent);
	await applyMediaEvent(mediaEvent, options);
}

async function applyLifecycleEvent(event: MediaLifecycleEvent, options: HandleWebhookOptions): Promise<void> {
	const { recordId, patch, read, remove } = options;
	const record = await read(recordId);
	if (!record) return;
	const lastAppliedAt = record[LIFECYCLE_EVENT_AT_FIELD];
	if (!isNewerEvent(event, typeof lastAppliedAt === "string" ? lastAppliedAt : undefined)) return;
	if (event.type === "media.deleted") {
		await remove?.(recordId);
		return;
	}
	const { changes, lock, etag } = event.data;
	const isLockChange = changes.includes("lock") || changes.includes("hold");
	await patch(recordId, {
		...(isLockChange ? { lock } : {}),
		etag,
		[LIFECYCLE_EVENT_AT_FIELD]: event.occurredAt,
	});
}

async function applyMediaEvent(event: MediaEvent, { recordId, patch, read }: HandleWebhookOptions): Promise<void> {
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
			// Wait in "captioning" only for requested captions that haven't arrived; without them, ready right away.
			const record = await read(recordId);
			const isWaitingForCaptions = record?.captionsPending === true;
			await patch(recordId, {
				transcodeStatus: isWaitingForCaptions ? MediaStatus.CAPTIONING : MediaStatus.READY,
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
				captionsPending: false,
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

/** A webhook that isn't authorized: a missing or wrong bearer, or a signature that doesn't verify. */
export class WebhookAuthError extends Error {
	constructor(message = "Unauthorized webhook.") {
		super(message);
		this.name = "WebhookAuthError";
	}
}

/**
 * Authenticates a webhook from the media Worker and returns its payload. A request with a `webhook-signature` header
 * is verified against `signingSecret` (the payload must be the raw body); any other one needs `Bearer <secret>`.
 * Throws a {@link WebhookAuthError} when it isn't authorized. Fails closed: without the matching secret nothing is accepted.
 */
export async function authenticateWebhook(
	payload: unknown,
	options: WebhookVerifyOptions,
): Promise<MediaEvent | WebhookEvent> {
	const signature = headerOf(options.headers, WEBHOOK_SIGNATURE_HEADER);
	if (signature && options.signingSecret) {
		if (typeof payload !== "string") {
			throw new WebhookAuthError("A signed webhook is verified against its raw body (a string).");
		}
		const verification = await verifyWebhookSignature({
			payload,
			headers: options.headers ?? {},
			secret: options.signingSecret,
			toleranceSeconds: options.toleranceSeconds,
		});
		if (!verification.ok) throw new WebhookAuthError(`Unauthorized webhook (${verification.reason}).`);
		return JSON.parse(payload) as WebhookEvent;
	}
	const authorization = options.authorization ?? headerOf(options.headers, "authorization");
	if (!isBearerOf(authorization ?? null, options.secret)) {
		throw new WebhookAuthError();
	}
	const event = typeof payload === "string" ? JSON.parse(payload) : payload;
	return event as MediaEvent;
}

function headerOf(headers: WebhookVerifyOptions["headers"], name: string): string | undefined {
	if (!headers) return undefined;
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? undefined;
}

export function createHTTPWebhookHandler(options: {
	secret: string;
	signingSecret?: WebhookVerifyOptions["signingSecret"];
}) {
	return {
		handler: async (_ctx: unknown, request: Request) => {
			const body = await request.text();
			try {
				const event = await authenticateWebhook(body, {
					authorization: request.headers.get("Authorization"),
					secret: options.secret,
					signingSecret: options.signingSecret,
					headers: request.headers,
				});
				return { event };
			} catch (error) {
				if (error instanceof WebhookAuthError) return new Response("Unauthorized", { status: 401 });
				throw error;
			}
		},
	};
}
