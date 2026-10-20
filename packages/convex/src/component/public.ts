import type { WorkerClient } from "@devultur/core";
import { DEFAULT_TOKEN_EXPIRY_SECONDS, extractId, MediaEventName, MediaStatus } from "@devultur/core";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { objectLockValidator } from "./lockValidators";
import { getMediaClient } from "./mediaClient";
import { transcodeOutputFields } from "./schema";
import { UPLOAD_CONFIRM_BACKSTOP_MS } from "./uploads";
import { workerAction } from "./workerErrors";

// Webhook path RELATIVE to the component. Convex gives the component a `CONVEX_SITE_URL` that ALREADY
// includes its mount prefix (e.g. `${site}/devultur`), so `${CONVEX_SITE_URL}/webhook` resolves to the
// mounted route (`${site}/devultur/webhook`) without duplicating the prefix. Do NOT add `/devultur/` here
// (that duplicates it).
const WEBHOOK_PATH = "/webhook";
// Accept-timeout (fail-fast): the machine emits the "downloading" heartbeat seconds after booting.
// If it's still "queued" at 90s, it never started → FAILED capacity/retriable (fast, not an opaque 5 min).
const ACCEPT_TIMEOUT_MS = 90 * 1000;
// Stuck-timeout (long encode): backstop in case the job hangs mid-processing.
const STUCK_TIMEOUT_MS = 45 * 60 * 1000;

// Reusable validator for the categorized failure reason (see FailureReason in @devultur/core).
const failureReasonValidator = v.union(
	v.literal("invalid_input"),
	v.literal("unsupported_codec"),
	v.literal("timeout"),
	v.literal("capacity"),
	v.literal("internal"),
);

// --- Media Actions (call CF Worker) ---

export const issueViewerToken = workerAction({
	args: { sessionSecret: v.optional(v.string()) },
	handler: async (_ctx, args) => {
		const media = getMediaClient();
		const { token, expiresIn } = await media.issueToken("viewer", {
			expiresIn: DEFAULT_TOKEN_EXPIRY_SECONDS,
			sessionSecret: args.sessionSecret,
		});
		return { token, expiresIn };
	},
});

export const createUploadUrl = workerAction({
	args: {
		filename: v.string(),
		contentType: v.string(),
		visibility: v.optional(v.union(v.literal("public"), v.literal("private"))),
		/** Lock of the new file (retention and/or hold), written with its bytes. */
		lock: v.optional(objectLockValidator),
		hold: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const media = getMediaClient();
		// Returns { url, key, id, kind, visibility } → the client assembles the DevulturMedia after the PUT.
		const upload = await media.createUploadUrl(args);
		// Backstop for a client that never confirms: records the upload later if its bytes were stored (uploads.ts).
		await ctx.scheduler.runAfter(UPLOAD_CONFIRM_BACKSTOP_MS, internal.uploads.confirmUploadLater, {
			key: upload.key,
			filename: args.filename,
		});
		return upload;
	},
});

export const deleteMediaAction = workerAction({
	args: { key: v.string() },
	handler: async (ctx, args) => {
		const media = getMediaClient();
		await media.delete(args.key);
		// Only once the Worker deleted it: a refused delete (a lock) keeps the file in the library.
		await ctx.runMutation(internal.uploads.forgetUpload, { key: args.key });
	},
});

export const deleteVideo = workerAction({
	args: { videoId: v.string(), visibility: v.optional(v.union(v.literal("public"), v.literal("private"))) },
	handler: async (ctx, args) => {
		const media = getMediaClient();
		const result = await media.deleteVideo(args.videoId, args.visibility);
		// The worker purges R2; here we clean up the component's records so a successful delete doesn't
		// leave a ghost `media` row (playlist/thumbnail giving 404s) or orphaned captions behind.
		await ctx.runMutation(internal.public.cleanupVideoRecords, { videoId: args.videoId });
		return result;
	},
});

// Cascade cleanup of the component's tables when a video is deleted (after the R2 purge in the worker):
// the `media` row (key = videoId) and its `captions` (by_media index). `progress` (watch history)
// is left orphaned but harmless — cascading it would require a `by_video` index.
export const cleanupVideoRecords = internalMutation({
	args: { videoId: v.string() },
	handler: async (ctx, args) => {
		const record = await ctx.db
			.query("media")
			.withIndex("by_key", (q) => q.eq("key", args.videoId))
			.first();
		if (record) await ctx.db.delete(record._id);

		const captions = await ctx.db
			.query("captions")
			.withIndex("by_media", (q) => q.eq("mediaKey", args.videoId))
			.collect();
		await Promise.all(captions.map((caption) => ctx.db.delete(caption._id)));
	},
});

export const processVideo = workerAction({
	args: {
		key: v.string(),
		preset: v.optional(v.string()),
		locales: v.optional(v.array(v.string())),
		callbackUrl: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const videoId = extractId(args.key);
		const mediaKey = videoId;

		const existing = await ctx.runQuery(api.public.getMediaByKey, { key: mediaKey });
		if (!existing) {
			const filename = args.key.split("/").pop() ?? args.key;
			await ctx.runMutation(api.public.createMedia, {
				key: mediaKey,
				type: "video" as const,
				filename,
				contentType: "video/mp4",
				sizeBytes: 0,
			});
		}

		const media = getMediaClient();
		// No preset → the config's default (or the usual HLS ladder if there is none).
		const preset = args.preset;
		const callbackUrl = args.callbackUrl ?? `${process.env.CONVEX_SITE_URL}${WEBHOOK_PATH}`;

		const hasCaptionLocales = (args.locales?.length ?? 0) > 0;

		// "queued" state BEFORE firing (feedback "requesting transcode…").
		// The transcode.started webhook will move it to "transcoding"; this order avoids a race.
		// `captionsPending` is set here too, before any webhook can land: `transcode.complete` reads it to choose
		// between "captioning" (captions still on their way) and "ready".
		await ctx.runMutation(api.public.updateMedia, {
			key: mediaKey,
			transcodeStatus: MediaStatus.QUEUED,
			captionsPending: hasCaptionLocales,
		});

		let result: Awaited<ReturnType<WorkerClient["transcode"]>>;
		try {
			result = await media.transcode(args.key, { preset, callbackUrl });
		} catch (error) {
			// Fail-loud: the worker didn't accept the transcode (token/suspend/error) → don't leave it hanging.
			const message = error instanceof Error ? error.message : "Could not start the transcode";
			await ctx.runMutation(api.public.updateMedia, {
				key: mediaKey,
				transcodeStatus: MediaStatus.FAILED,
				transcodeError: message,
				failureReason: "internal",
				retriable: true,
			});
			throw error;
		}

		// Captions is best-effort: its failure shouldn't mark the video as failed, nor leave it waiting for
		// captions that will never arrive.
		if (args.locales && hasCaptionLocales) {
			try {
				await media.requestCaptions(args.key, args.locales, { callbackUrl });
			} catch {
				await ctx.runMutation(internal.public.skipCaptions, { key: mediaKey });
			}
		}

		// Accept-timeout (fast): if the machine never emitted the "downloading" heartbeat it's still "queued".
		// Stuck-timeout (long): backstop if the job hangs mid-processing.
		await ctx.scheduler.runAfter(ACCEPT_TIMEOUT_MS, internal.public.checkTranscodeAccepted, { key: mediaKey });
		await ctx.scheduler.runAfter(STUCK_TIMEOUT_MS, internal.public.checkTranscodeStuck, { key: mediaKey });

		return result;
	},
});

// The captions request failed: stop waiting for them. A video whose transcode already completed (and is
// waiting in "captioning") becomes ready.
export const skipCaptions = internalMutation({
	args: { key: v.string() },
	handler: async (ctx, args) => {
		const record = await ctx.db
			.query("media")
			.withIndex("by_key", (q) => q.eq("key", args.key))
			.first();
		if (!record) return;

		const isWaitingForCaptions = record.transcodeStatus === MediaStatus.CAPTIONING;
		await ctx.db.patch(record._id, {
			captionsPending: false,
			...(isWaitingForCaptions ? { transcodeStatus: MediaStatus.READY } : {}),
		});
	},
});

// Fail-fast: if the video is still "queued" at 90s (the machine never started), mark it FAILED with
// reason `capacity` and retriable — a transient startup failure, not an invalid input.
export const checkTranscodeAccepted = internalMutation({
	args: { key: v.string() },
	handler: async (ctx, args) => {
		const record = await ctx.db
			.query("media")
			.withIndex("by_key", (q) => q.eq("key", args.key))
			.first();
		if (!record || record.transcodeStatus !== MediaStatus.QUEUED) return;

		await ctx.db.patch(record._id, {
			transcodeStatus: MediaStatus.FAILED,
			transcodeError: "The transcode didn't start in time. Retry.",
			failureReason: "capacity",
			retriable: true,
			transcodeProgress: undefined,
		});
	},
});

// Long-encode backstop: if the video hasn't reached ready/failed after the max time, it got stuck
// mid-way → FAILED with reason `timeout` and retriable.
export const checkTranscodeStuck = internalMutation({
	args: { key: v.string() },
	handler: async (ctx, args) => {
		const record = await ctx.db
			.query("media")
			.withIndex("by_key", (q) => q.eq("key", args.key))
			.first();
		if (!record) return;
		if (record.transcodeStatus === MediaStatus.READY || record.transcodeStatus === MediaStatus.FAILED) return;

		await ctx.db.patch(record._id, {
			transcodeStatus: MediaStatus.FAILED,
			transcodeError: "The transcode didn't finish in time. Retry.",
			failureReason: "timeout",
			retriable: true,
			transcodeProgress: undefined,
		});
	},
});

// --- Media Mutations (component tables) ---

export const createMedia = mutation({
	args: {
		key: v.string(),
		type: v.union(v.literal("video"), v.literal("image"), v.literal("file")),
		filename: v.string(),
		contentType: v.string(),
		sizeBytes: v.number(),
	},
	handler: async (ctx, args) => {
		// One record per key: `processVideo` and a confirmed upload can both get here first.
		const existing = await ctx.db
			.query("media")
			.withIndex("by_key", (q) => q.eq("key", args.key))
			.first();
		if (existing) return existing._id;
		return ctx.db.insert("media", { ...args, createdAt: Date.now() });
	},
});

export const updateMedia = mutation({
	args: {
		key: v.string(),
		transcodeStatus: v.optional(
			v.union(
				v.literal("queued"),
				v.literal("transcoding"),
				v.literal("captioning"),
				v.literal("ready"),
				v.literal("failed"),
			),
		),
		transcodeProgress: v.optional(v.object({ current: v.number(), total: v.number() })),
		transcodeError: v.optional(v.string()),
		failureReason: v.optional(failureReasonValidator),
		retriable: v.optional(v.boolean()),
		playlistUrl: v.optional(v.string()),
		thumbnailKey: v.optional(v.string()),
		captionLocales: v.optional(v.array(v.string())),
		captionsPending: v.optional(v.boolean()),
		duration: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const record = await ctx.db
			.query("media")
			.withIndex("by_key", (q) => q.eq("key", args.key))
			.first();
		if (!record) return;

		const { key: _mediaKey, ...fields } = args;
		const patch: Record<string, unknown> = {};
		for (const [fieldName, fieldValue] of Object.entries(fields)) {
			if (fieldValue !== undefined) patch[fieldName] = fieldValue;
		}
		if (Object.keys(patch).length > 0) {
			await ctx.db.patch(record._id, patch);
		}
	},
});

// --- Media Queries ---

export const getMediaByKey = query({
	args: { key: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("media")
			.withIndex("by_key", (q) => q.eq("key", args.key))
			.first();
	},
});

export const listMedia = query({
	args: { type: v.optional(v.union(v.literal("video"), v.literal("image"), v.literal("file"))) },
	handler: async (ctx, args) => {
		const mediaQuery = ctx.db.query("media");
		if (args.type) {
			return mediaQuery.filter((q) => q.eq(q.field("type"), args.type)).collect();
		}
		return mediaQuery.collect();
	},
});

// --- Captions ---

export const upsertCaption = mutation({
	args: {
		mediaKey: v.string(),
		locale: v.string(),
		vttUrl: v.string(),
		srtUrl: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("captions")
			.withIndex("by_media_locale", (q) => q.eq("mediaKey", args.mediaKey).eq("locale", args.locale))
			.first();

		if (existing) {
			await ctx.db.patch(existing._id, { vttUrl: args.vttUrl, srtUrl: args.srtUrl });
			return existing._id;
		}
		return ctx.db.insert("captions", { ...args, createdAt: Date.now() });
	},
});

export const listCaptionsByMedia = query({
	args: { mediaKey: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("captions")
			.withIndex("by_media", (q) => q.eq("mediaKey", args.mediaKey))
			.collect();
	},
});

// --- Progress ---

function findProgress(ctx: QueryCtx | MutationCtx, userId: string, videoId: string) {
	return ctx.db
		.query("progress")
		.withIndex("by_user_video", (q) => q.eq("userId", userId).eq("videoId", videoId))
		.first();
}

export const saveProgress = mutation({
	args: { userId: v.string(), videoId: v.string(), position: v.number() },
	handler: async (ctx, args) => {
		const existing = await findProgress(ctx, args.userId, args.videoId);

		if (existing) {
			await ctx.db.patch(existing._id, { lastPosition: args.position, updatedAt: Date.now() });
			return existing._id;
		}
		return ctx.db.insert("progress", {
			userId: args.userId,
			videoId: args.videoId,
			lastPosition: args.position,
			updatedAt: Date.now(),
		});
	},
});

export const loadProgress = query({
	args: { userId: v.string(), videoId: v.string() },
	handler: async (ctx, args) => {
		return findProgress(ctx, args.userId, args.videoId);
	},
});

export const markComplete = mutation({
	args: { userId: v.string(), videoId: v.string() },
	handler: async (ctx, args) => {
		const existing = await findProgress(ctx, args.userId, args.videoId);
		const now = Date.now();

		if (existing) {
			await ctx.db.patch(existing._id, { completedAt: now, watchedPercent: 100, updatedAt: now });
			return existing._id;
		}
		return ctx.db.insert("progress", {
			userId: args.userId,
			videoId: args.videoId,
			lastPosition: 0,
			completedAt: now,
			watchedPercent: 100,
			updatedAt: now,
		});
	},
});

export const resetProgress = mutation({
	args: { userId: v.string(), videoId: v.string() },
	handler: async (ctx, args) => {
		const existing = await findProgress(ctx, args.userId, args.videoId);
		if (existing) {
			await ctx.db.delete(existing._id);
		}
	},
});

export const getCourseProgress = query({
	args: { userId: v.string(), videoIds: v.array(v.string()) },
	handler: async (ctx, args) => {
		return Promise.all(args.videoIds.map((videoId) => findProgress(ctx, args.userId, videoId)));
	},
});

// --- Webhook Handler (updates component's media table) ---

export const handleWebhookEvent = internalMutation({
	args: {
		event: v.string(),
		videoId: v.string(),
		currentSegment: v.optional(v.number()),
		totalSegments: v.optional(v.number()),
		phase: v.optional(v.string()),
		duration: v.optional(v.number()),
		playlistKey: v.optional(v.string()),
		thumbnailKey: v.optional(v.string()),
		// Outputs of a config preset / inline spec (MP4, variants, poster). Absent with the `hls-*` aliases.
		...transcodeOutputFields,
		locales: v.optional(v.array(v.string())),
		error: v.optional(v.string()),
		reason: v.optional(failureReasonValidator),
		retriable: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		let record = await ctx.db
			.query("media")
			.withIndex("by_key", (q) => q.eq("key", args.videoId))
			.first();
		if (!record) {
			record = await ctx.db
				.query("media")
				.withIndex("by_key", (q) => q.eq("key", `videos/${args.videoId}`))
				.first();
		}
		if (!record) return;

		switch (args.event) {
			case MediaEventName.TRANSCODE_STARTED:
				await ctx.db.patch(record._id, {
					transcodeStatus: MediaStatus.TRANSCODING,
					transcodeProgress: { current: 0, total: args.totalSegments ?? 0 },
					transcodeError: undefined,
					duration: args.duration,
				});
				break;

			case MediaEventName.TRANSCODE_PROGRESS:
				// The "downloading" heartbeat is the first progress → moves out of "queued" as soon as the machine is alive.
				await ctx.db.patch(record._id, {
					transcodeStatus: MediaStatus.TRANSCODING,
					transcodeProgress: {
						current: args.currentSegment ?? 0,
						total: args.totalSegments ?? 0,
						phase: (args.phase as "downloading" | "encoding" | "uploading" | "captioning") ?? "uploading",
					},
					transcodeError: undefined,
				});
				break;

			case MediaEventName.TRANSCODE_COMPLETE: {
				// Wait in "captioning" only for captions that were requested and haven't arrived yet; a video
				// transcoded without captions is ready right away.
				await ctx.db.patch(record._id, {
					transcodeStatus: record.captionsPending ? MediaStatus.CAPTIONING : MediaStatus.READY,
					transcodeProgress: undefined,
					duration: args.duration,
					playlistUrl: args.playlistKey,
					thumbnailKey: args.thumbnailKey,
					...(args.renditions ? { renditions: args.renditions } : {}),
					...(args.posterUrls ? { posterUrls: args.posterUrls } : {}),
					...(args.hasAudio !== undefined ? { hasAudio: args.hasAudio } : {}),
					...(args.storyboardKey ? { storyboardKey: args.storyboardKey } : {}),
				});
				break;
			}

			case MediaEventName.CAPTIONS_COMPLETE: {
				// An MP4-only preset has no playlist: its renditions also count as "transcode ready".
				const hasPlaylist = !!record.playlistUrl || (record.renditions?.length ?? 0) > 0;
				await ctx.db.patch(record._id, {
					transcodeStatus: hasPlaylist ? MediaStatus.READY : MediaStatus.TRANSCODING,
					captionLocales: args.locales,
					captionsPending: false,
				});
				break;
			}

			case MediaEventName.TRANSCODE_FAILED:
			case MediaEventName.CAPTIONS_FAILED:
				await ctx.db.patch(record._id, {
					transcodeStatus: MediaStatus.FAILED,
					transcodeError: args.error,
					failureReason: args.reason ?? "internal",
					retriable: args.retriable ?? true,
					transcodeProgress: undefined,
				});
				break;
		}
	},
});
