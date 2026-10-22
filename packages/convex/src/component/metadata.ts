// Editing a media record's descriptive metadata (title, alt text, tags). The upload's own facts (size, dimensions,
// duration, page count) are recorded by `uploads.ts` and the transcode webhook, never edited here.
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation } from "./_generated/server";
import { mediaMetaPatch, searchTextOf } from "./mediaMeta";

/**
 * Sets a record's `title`, `alt` and/or `tags` (only the ones passed). Trimmed; an empty title or alt clears it, and
 * tags are deduplicated. Throws `invalid_media_metadata` past the limits (title 200, alt 1000, 20 tags of 50). Returns
 * the updated record, or `null` when no record has this media id.
 */
export const updateMediaMeta = mutation({
	args: {
		key: v.string(),
		title: v.optional(v.string()),
		alt: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
	},
	handler: async (ctx, args): Promise<Doc<"media"> | null> => {
		const { key, ...input } = args;
		const patch = mediaMetaPatch(input);
		const record = await ctx.db
			.query("media")
			.withIndex("by_key", (q) => q.eq("key", key))
			.first();
		if (!record) return null;

		const title = "title" in patch ? patch.title : record.title;
		await ctx.db.patch(record._id, { ...patch, searchText: searchTextOf(title, record.filename) });
		return ctx.db.get(record._id);
	},
});
