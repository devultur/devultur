// Upload records: every upload (video, image, file) gets a `media` record once its bytes are stored, so `listMedia` is
// the app's media library. A record is only written after a HEAD on the Worker finds the object: an abandoned PUT never
// shows up. The client confirms right after its PUT (`confirmUpload`); `createUploadUrl` also schedules the same check
// for later (`confirmUploadLater`), so an upload whose client never confirmed is still recorded.
import type { FileHead } from "@devultur/core";
import { extractId, sanitizeFilename } from "@devultur/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { internalAction, internalMutation } from "./_generated/server";
import { getMediaClient } from "./mediaClient";
import { checkUploadHints, searchTextOf, type UploadHints } from "./mediaMeta";
import { parseUploadKey, type UploadKey } from "./uploadKeys";
import { workerAction } from "./workerErrors";

// Past the Worker's longest upload window (a multipart upload can run for 24 hours), so the scheduled check never runs
// while the bytes are still on their way.
export const UPLOAD_CONFIRM_BACKSTOP_MS = 25 * 60 * 60 * 1000;

/** The display name to store: the client's when it is the name in the key, else the key's own. */
function displayName(uploadKey: UploadKey, filename: string | undefined): string {
	if (filename && sanitizeFilename(filename) === uploadKey.storedName) return filename;
	return uploadKey.storedName;
}

// The hints are the uploading client's word, not the Worker's: positive integers up to 100,000, else
// `invalid_media_metadata`. An image size the Worker read from the bytes wins over them.
const confirmArgs = {
	key: v.string(),
	/** The original filename (display and download name). Ignored unless it is the one in the key. */
	filename: v.optional(v.string()),
	/** Intrinsic size of an image, read in the browser. */
	width: v.optional(v.number()),
	height: v.optional(v.number()),
	/** A PDF's page count, counted in the browser (`countPdfPages`). Recorded for PDFs only. */
	pageCount: v.optional(v.number()),
};

interface ConfirmArgs extends UploadHints {
	key: string;
	filename?: string;
}

/** The size to record: the Worker's (read from the bytes) when it has one, else the client's hint. */
function recordedSize(head: FileHead, hints: UploadHints): { width?: number; height?: number } {
	if (head.width && head.height) return { width: head.width, height: head.height };
	return {
		...(hints.width !== undefined ? { width: hints.width } : {}),
		...(hints.height !== undefined ? { height: hints.height } : {}),
	};
}

/** HEADs the object and records it; `null` when no object is stored at `key` (yet). */
// Annotated: the result of `internal.uploads.*` would otherwise type this module in terms of itself.
async function confirm(ctx: ActionCtx, args: ConfirmArgs): Promise<Doc<"media"> | null> {
	const uploadKey = parseUploadKey(args.key);
	if (!uploadKey) {
		throw new ConvexError({ code: "invalid_upload_key", message: `Not an upload key: ${args.key}`, status: 400 });
	}
	checkUploadHints(args);

	const head: FileHead | null = await getMediaClient().files.head(args.key);
	if (!head) return null;

	const isPdf = head.contentType === "application/pdf";
	return ctx.runMutation(internal.uploads.recordUpload, {
		key: uploadKey.id,
		objectKey: args.key,
		type: uploadKey.kind,
		visibility: uploadKey.visibility,
		filename: displayName(uploadKey, args.filename),
		contentType: head.contentType,
		sizeBytes: head.size,
		...recordedSize(head, args),
		...(isPdf && args.pageCount !== undefined ? { pageCount: args.pageCount } : {}),
	});
}

/**
 * Records an upload in the component's `media` table once its bytes are stored (call it after the PUT). Returns the
 * record, or `null` when nothing is stored at `key`. Idempotent: confirming twice updates the same record, and a
 * video's transcode state is left as it is.
 */
export const confirmUpload = workerAction({
	args: confirmArgs,
	handler: async (ctx, args): Promise<Doc<"media"> | null> => confirm(ctx, args),
});

/** The scheduled check `createUploadUrl` leaves behind: records the upload if it was stored and never confirmed. */
export const confirmUploadLater = internalAction({
	args: confirmArgs,
	handler: async (ctx, args) => {
		await confirm(ctx, args);
	},
});

export const recordUpload = internalMutation({
	args: {
		key: v.string(),
		objectKey: v.string(),
		type: v.union(v.literal("video"), v.literal("image"), v.literal("file")),
		visibility: v.union(v.literal("public"), v.literal("private")),
		filename: v.string(),
		contentType: v.string(),
		sizeBytes: v.number(),
		width: v.optional(v.number()),
		height: v.optional(v.number()),
		pageCount: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("media")
			.withIndex("by_key", (q) => q.eq("key", args.key))
			.first();
		if (!existing) {
			const searchText = searchTextOf(undefined, args.filename);
			const id = await ctx.db.insert("media", { ...args, searchText, createdAt: Date.now() });
			return ctx.db.get(id);
		}

		// A video `processVideo` recorded first: fill in what only the upload knows, keep its transcode state (and any
		// title the app already set).
		await ctx.db.patch(existing._id, { ...args, searchText: searchTextOf(existing.title, args.filename) });
		return ctx.db.get(existing._id);
	},
});

/** Drops the record of a deleted image or file. A video's record goes with `deleteVideo`, not with one of its keys. */
export const forgetUpload = internalMutation({
	args: { key: v.string() },
	handler: async (ctx, args) => {
		if (!parseUploadKey(args.key)) return;
		const record = await ctx.db
			.query("media")
			.withIndex("by_key", (q) => q.eq("key", extractId(args.key)))
			.first();
		if (!record || record.type === "video") return;
		if (record.objectKey && record.objectKey !== args.key) return;
		await ctx.db.delete(record._id);
	},
});
