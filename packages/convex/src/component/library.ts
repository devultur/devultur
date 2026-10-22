// The media library: search over the records' `searchText` (title + filename), and the one-off backfill that gives
// records from before 1.4.0 the `searchText` they were written without.
import { type PaginationOptions, type PaginationResult, paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { missingSearchText } from "./mediaMeta";

const mediaType = v.union(v.literal("video"), v.literal("image"), v.literal("file"));
type MediaType = Doc<"media">["type"];

/** Longest search kept: Convex matches at most 16 terms, so a longer query only costs. */
const SEARCH_MAX_LENGTH = 200;
export const BACKFILL_BATCH_SIZE = { default: 100, max: 1000 } as const;

/** One page of the library, newest first, optionally of one kind (`by_type` index). */
export function listNewestFirst(
	ctx: QueryCtx,
	type: MediaType | undefined,
	paginationOpts: PaginationOptions,
): Promise<PaginationResult<Doc<"media">>> {
	const records = type ? ctx.db.query("media").withIndex("by_type", (q) => q.eq("type", type)) : ctx.db.query("media");
	return records.order("desc").paginate(paginationOpts);
}

/**
 * One page of the records whose title or filename matches `search` (the last word as a prefix), best match first,
 * optionally of one kind. A blank `search` lists the library newest first, like `listMediaPage`. Records from before
 * 1.4.0 match only once they have a `searchText` (`backfillSearchText`, or any write to them).
 */
export const searchMedia = query({
	args: { search: v.string(), type: v.optional(mediaType), paginationOpts: paginationOptsValidator },
	handler: async (ctx, args): Promise<PaginationResult<Doc<"media">>> => {
		const { type, paginationOpts } = args;
		const search = args.search.trim().toLowerCase().slice(0, SEARCH_MAX_LENGTH);
		if (search === "") return listNewestFirst(ctx, type, paginationOpts);

		return ctx.db
			.query("media")
			.withSearchIndex("search_text", (q) => {
				const matches = q.search("searchText", search);
				return type ? matches.eq("type", type) : matches;
			})
			.paginate(paginationOpts);
	},
});

interface BackfillResult {
	/** Records given a `searchText` by this batch. */
	updated: number;
	/** `false` while later batches are scheduled. */
	isDone: boolean;
}

function batchSizeOf(requested: number | undefined): number {
	if (requested === undefined || !Number.isFinite(requested)) return BACKFILL_BATCH_SIZE.default;
	return Math.min(Math.max(Math.floor(requested), 1), BACKFILL_BATCH_SIZE.max);
}

/** Fills one page of records, then schedules the next page until the table is done. */
async function backfillBatch(ctx: MutationCtx, cursor: string | null, batchSize: number): Promise<BackfillResult> {
	const page = await ctx.db.query("media").paginate({ cursor, numItems: batchSize });
	let updated = 0;
	for (const record of page.page) {
		const fill = missingSearchText(record);
		if (fill.searchText === undefined) continue;
		await ctx.db.patch(record._id, fill);
		updated++;
	}
	if (!page.isDone) {
		await ctx.scheduler.runAfter(0, internal.library.backfillSearchTextBatch, {
			cursor: page.continueCursor,
			batchSize,
		});
	}
	return { updated, isDone: page.isDone };
}

/**
 * Gives every record without a `searchText` (written before 1.4.0) its title and filename, `batchSize` records per
 * mutation (default 100, at most 1000). Runs the first batch now and schedules the rest; safe to run again.
 */
export const backfillSearchText = mutation({
	args: { batchSize: v.optional(v.number()) },
	handler: async (ctx, args): Promise<BackfillResult> => backfillBatch(ctx, null, batchSizeOf(args.batchSize)),
});

export const backfillSearchTextBatch = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), batchSize: v.number() },
	handler: async (ctx, args): Promise<BackfillResult> => backfillBatch(ctx, args.cursor, args.batchSize),
});
