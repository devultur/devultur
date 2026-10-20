import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
		// Set by a confirmed upload (see uploads.ts). Unset on records from before 1.1.1 and on videos recorded only by
		// `processVideo`. The record's `key` is the media id for every kind; `objectKey` is the stored object's key.
		visibility: v.optional(v.union(v.literal("public"), v.literal("private"))),
		objectKey: v.optional(v.string()),
		width: v.optional(v.number()),
		height: v.optional(v.number()),
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
		duration: v.optional(v.number()),
		createdAt: v.number(),
	}).index("by_key", ["key"]),

	captions: defineTable({
		mediaKey: v.string(),
		locale: v.string(),
		vttUrl: v.string(),
		srtUrl: v.optional(v.string()),
		createdAt: v.number(),
	})
		.index("by_media", ["mediaKey"])
		.index("by_media_locale", ["mediaKey", "locale"]),

	progress: defineTable({
		userId: v.string(),
		videoId: v.string(),
		lastPosition: v.number(),
		completedAt: v.optional(v.number()),
		watchedPercent: v.optional(v.number()),
		updatedAt: v.number(),
	}).index("by_user_video", ["userId", "videoId"]),
});
