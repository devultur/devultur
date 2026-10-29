// Deleting a media's records: its `media` row and its `captions`. `progress` (watch history) stays, orphaned but
// harmless: cascading it would need a `by_video` index.
import type { MutationCtx } from "./_generated/server";

export async function deleteMediaRecords(ctx: MutationCtx, key: string): Promise<boolean> {
	const record = await ctx.db
		.query("media")
		.withIndex("by_key", (q) => q.eq("key", key))
		.first();
	if (record) await ctx.db.delete(record._id);

	const captions = await ctx.db
		.query("captions")
		.withIndex("by_media", (q) => q.eq("mediaKey", key))
		.collect();
	await Promise.all(captions.map((caption) => ctx.db.delete(caption._id)));
	return record !== null;
}
