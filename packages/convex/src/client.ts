import type { HoldPage, LockView, ObjectLock, SetLockOptions } from "@devultur/core";
import type { GenericActionCtx, GenericDataModel, PaginationOptions, PaginationResult } from "convex/server";
import type { ComponentApi } from "./component/_generated/component.js";
import { exposedFunctions, registerFunctions } from "./exposed-functions";
import type { DevulturFunctionResults, MediaDocument, ProgressDocument } from "./function-results";
import type { DevulturComponentConfig } from "./types";

type DevulturComponent = ComponentApi;
// Only the runner each method calls, so an app's ctx fits whatever its `DataModel` (a `GenericQueryCtx<DataModel>`
// isn't a `GenericQueryCtx<GenericDataModel>`: its `db` knows only the app's tables). The action ctx's runners, which
// take no options, so a query's, a mutation's and an action's all fit where they have the runner.
type Runners = GenericActionCtx<GenericDataModel>;
type QueryCtx = Pick<Runners, "runQuery">;
type MutationCtx = Pick<Runners, "runMutation">;
type ActionCtx = Pick<Runners, "runAction">;
type UploadUrlArgs = { filename: string; contentType: string; visibility?: "public" | "private" };
type MediaType = "video" | "image" | "file";
type MediaPageArgs = { type?: MediaType; paginationOpts: PaginationOptions };
type SearchMediaArgs = MediaPageArgs & { search: string };
/** `updated`: records this first batch filled. `isDone`: `false` while later batches are scheduled. */
type BackfillResult = { updated: number; isDone: boolean };
type ConfirmUploadArgs = { key: string; filename?: string; width?: number; height?: number; pageCount?: number };
type MediaMetaArgs = { key: string; title?: string; alt?: string; tags?: string[] };

export class Devultur {
	/** The mounted component (`components.devultur`) this client calls. */
	readonly component: DevulturComponent;

	constructor(component: DevulturComponent) {
		this.component = component;
	}

	async getMedia(ctx: QueryCtx, key: string): Promise<MediaDocument | null> {
		return ctx.runQuery(this.component.public.getMediaByKey, { key });
	}

	/** Returns the progress record's id. */
	async saveProgress(ctx: MutationCtx, args: { userId: string; videoId: string; position: number }): Promise<string> {
		return ctx.runMutation(this.component.public.saveProgress, args);
	}

	async loadProgress(ctx: QueryCtx, args: { userId: string; videoId: string }): Promise<ProgressDocument | null> {
		return ctx.runQuery(this.component.public.loadProgress, args);
	}

	/** An upload URL from your server, optionally locked (retention and/or hold, written with the bytes). */
	async createUploadUrl(
		ctx: ActionCtx,
		args: UploadUrlArgs & { lock?: ObjectLock; hold?: boolean },
	): Promise<DevulturFunctionResults["createUploadUrl"]> {
		return ctx.runAction(this.component.public.createUploadUrl, args);
	}

	/**
	 * Records an upload in the component once its bytes are stored (after the PUT): it then shows in `listMedia`.
	 * Returns the record, or `null` when nothing is stored at `key`. Uploads nobody confirms are recorded a day later.
	 * `width`, `height` and `pageCount` are the client's hints (positive integers up to 100,000); an image size the
	 * Worker read from the bytes wins over them.
	 */
	async confirmUpload(ctx: ActionCtx, args: ConfirmUploadArgs): Promise<MediaDocument | null> {
		return ctx.runAction(this.component.uploads.confirmUpload, args);
	}

	/**
	 * Sets a record's `title`, `alt` and/or `tags` (only the ones passed; an empty string clears a title or alt, `[]`
	 * the tags). `key` is the media id. Trimmed and deduplicated; past title 200, alt 1000 or 20 tags of 50 characters
	 * it throws `invalid_media_metadata`. Returns the updated record, or `null` when there is none.
	 */
	async updateMediaMeta(ctx: MutationCtx, args: MediaMetaArgs): Promise<MediaDocument | null> {
		return ctx.runMutation(this.component.metadata.updateMediaMeta, args);
	}

	/**
	 * The recorded media (every confirmed upload, and every video sent to `processVideo`), optionally of one type.
	 * `mediaFromRecord(record)` turns a row into the reference `<Image>` and `dv.media()` take. Unbounded: it reads every
	 * record, so a media library pages with `listMediaPage`.
	 */
	async listMedia(ctx: QueryCtx, args?: { type?: MediaType }): Promise<MediaDocument[]> {
		return ctx.runQuery(this.component.public.listMedia, args ?? {});
	}

	/** One page of the recorded media, newest first, optionally of one type. Takes Convex's `paginationOpts`. */
	async listMediaPage(ctx: QueryCtx, args: MediaPageArgs): Promise<PaginationResult<MediaDocument>> {
		return ctx.runQuery(this.component.public.listMediaPage, args);
	}

	/**
	 * One page of the records whose title or filename matches `search` (its last word as a prefix), best match first,
	 * optionally of one type. A blank `search` lists newest first, like `listMediaPage`. Records from before 1.4.0
	 * match once `backfillSearchText` (or any write) gives them a `searchText`.
	 */
	async searchMedia(ctx: QueryCtx, args: SearchMediaArgs): Promise<PaginationResult<MediaDocument>> {
		return ctx.runQuery(this.component.library.searchMedia, args);
	}

	/**
	 * One-off for records written before 1.4.0: gives every record without a `searchText` one, `batchSize` records
	 * per mutation (default 100, at most 1000). Runs the first batch and schedules the rest. Safe to run again.
	 */
	async backfillSearchText(ctx: MutationCtx, options?: { batchSize?: number }): Promise<BackfillResult> {
		return ctx.runMutation(this.component.library.backfillSearchText, options ?? {});
	}

	/** The lock in force on `key`. */
	async getLock(ctx: ActionCtx, key: string): Promise<LockView> {
		return ctx.runAction(this.component.lock.getLock, { key });
	}

	/** Sets or extends `key`'s retention (shortening a governance one needs `bypassGovernance` and the Worker's hook). */
	async setLock(ctx: ActionCtx, key: string, options: SetLockOptions): Promise<LockView> {
		return ctx.runAction(this.component.lock.setLock, { key, ...options });
	}

	/** Holds `keys` (any number: sent in pages). A bulk hold by prefix uses `@devultur/core`'s client on your server. */
	async setHold(ctx: ActionCtx, keys: string[]): Promise<Pick<HoldPage, "updated" | "skipped">> {
		return ctx.runAction(this.component.lock.setHold, { keys });
	}

	/**
	 * The keys (media ids) of `keys` with no record in the component, each once: references your tables keep to media
	 * that's gone. At most 500 per call; check a large table in pages, for example from a cron.
	 */
	async missingKeys(ctx: QueryCtx, keys: string[]): Promise<string[]> {
		return ctx.runQuery(this.component.lifecycle.missingKeys, { keys });
	}

	/** Releases `keys`' holds: a retention `period` starts now; without a retention they're free. */
	async releaseHold(ctx: ActionCtx, keys: string[]): Promise<Pick<HoldPage, "updated" | "skipped">> {
		return ctx.runAction(this.component.lock.releaseHold, { keys });
	}

	/**
	 * The component's functions for your app to export. They have no auth of their own: anyone who can call your
	 * Convex deployment can call them. `defineDevulturFunctions` returns the same functions behind your guard.
	 */
	static exposeApi(component: DevulturComponent, config?: DevulturComponentConfig) {
		return registerFunctions(exposedFunctions(component, config), "public", (_name, fn) => {
			return (ctx, args) => fn.handler(ctx, args, {});
		});
	}
}
