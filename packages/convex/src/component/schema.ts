import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { objectLockValidator } from "./lockValidators";

// Outputs of a preset transcode (carried by `transcode.complete`): each MP4/ladder with its stable URL, the
// poster (JPG + AVIF per transform), and whether the video ended up with audio.
export const transcodeOutputFields = {
	renditions: v.optional(
		v.array(
			v.object({
				variant: v.string(),
				kind: v.union(v.literal("hls"), v.literal("mp4")),
				rung: v.string(),
				key: v.string(),
				width: v.optional(v.number()),
				height: v.optional(v.number()),
				url: v.string(),
			}),
		),
	),
	posterUrls: v.optional(v.object({ jpg: v.optional(v.string()), avif: v.optional(v.string()) })),
	hasAudio: v.optional(v.boolean()),
	// Key of the storyboard VTT (scrub-bar previews). URL: `buildStoryboardUrl` / `buildMediaUrl` from core.
	storyboardKey: v.optional(v.string()),
};

export default defineSchema({
	media: defineTable({
		key: v.string(),
		type: v.union(v.literal("video"), v.literal("image"), v.literal("file")),
		filename: v.string(),
		contentType: v.string(),
		sizeBytes: v.number(),
		// Set by a confirmed upload (see uploads.ts). Unset on records from before 1.1.0 and on videos recorded only by
		// `processVideo`. The record's `key` is the media id for every kind; `objectKey` is the stored object's key.
		visibility: v.optional(v.union(v.literal("public"), v.literal("private"))),
		objectKey: v.optional(v.string()),
		// An image's intrinsic size: read by the Worker from the bytes when it can, else the uploading client's hint.
		width: v.optional(v.number()),
		height: v.optional(v.number()),
		// A PDF's page count, as the uploading client reported it (a hint, see `confirmUpload`).
		pageCount: v.optional(v.number()),
		// Set by the app (`updateMediaMeta`).
		title: v.optional(v.string()),
		alt: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
		// `title + " " + filename`, lowercased, kept in step on every write. Unset on records from before 1.4.0.
		searchText: v.optional(v.string()),
		transcodeStatus: v.optional(
			v.union(
				v.literal("queued"),
				v.literal("transcoding"),
				v.literal("captioning"),
				v.literal("ready"),
				v.literal("failed"),
			),
		),
		transcodeProgress: v.optional(
			v.object({
				current: v.number(),
				total: v.number(),
				phase: v.optional(
					v.union(v.literal("downloading"), v.literal("encoding"), v.literal("uploading"), v.literal("captioning")),
				),
			}),
		),
		transcodeError: v.optional(v.string()),
		// Categorized failure + whether it's retriable (webhook / accept-timeout). See FailureReason in core.
		failureReason: v.optional(
			v.union(
				v.literal("invalid_input"),
				v.literal("unsupported_codec"),
				v.literal("timeout"),
				v.literal("capacity"),
				v.literal("internal"),
			),
		),
		retriable: v.optional(v.boolean()),
		playlistUrl: v.optional(v.string()),
		thumbnailKey: v.optional(v.string()),
		// Outputs of a preset transcode: each MP4/ladder with its stable URL, poster, and whether it has audio.
		...transcodeOutputFields,
		captionLocales: v.optional(v.array(v.string())),
		// True while requested captions haven't arrived: `transcode.complete` then waits in "captioning" instead
		// of going straight to "ready". Unset (records from before this field) means no captions were requested.
		captionsPending: v.optional(v.boolean()),
		// A video's duration in seconds, from the transcode's webhook.
		duration: v.optional(v.number()),
		// From the Worker's lifecycle events (`media.changed`): the lock in force after the last lock or hold change, the
		// stored object's etag, and whether a video's original was deleted (its outputs stay). `lifecycleEventAt` is the
		// `occurredAt` (and `lifecycleEventId`, the tiebreak) of the last event applied: events arrive unordered, and an older
		// one is ignored.
		lock: v.optional(objectLockValidator),
		etag: v.optional(v.string()),
		originalDeleted: v.optional(v.boolean()),
		lifecycleEventAt: v.optional(v.string()),
		lifecycleEventId: v.optional(v.string()),
		createdAt: v.number(),
	})
		.index("by_key", ["key"])
		// The media library by kind (`listMediaPage`), newest first.
		.index("by_type", ["type"])
		// Full-text search over the title and filename, optionally of one kind.
		.searchIndex("search_text", { searchField: "searchText", filterFields: ["type"] }),

	captions: defineTable({
		mediaKey: v.string(),
		locale: v.string(),
		vttUrl: v.string(),
		srtUrl: v.optional(v.string()),
		createdAt: v.number(),
	})
		.index("by_media", ["mediaKey"])
		.index("by_media_locale", ["mediaKey", "locale"]),

	// Lifecycle events already applied, by id: the Worker delivers at least once. `received`: applied to the component,
	// the app's handler not done yet (a redelivery runs it again); `handled`: done. Kept 7 days (a daily cron prunes).
	processedEvents: defineTable({
		eventId: v.string(),
		status: v.union(v.literal("received"), v.literal("handled")),
		type: v.string(),
		mediaId: v.string(),
		occurredAt: v.string(),
		processedAt: v.number(),
	})
		.index("by_event_id", ["eventId"])
		.index("by_processed_at", ["processedAt"]),

	progress: defineTable({
		userId: v.string(),
		videoId: v.string(),
		lastPosition: v.number(),
		completedAt: v.optional(v.number()),
		watchedPercent: v.optional(v.number()),
		updatedAt: v.number(),
	}).index("by_user_video", ["userId", "videoId"]),
});
