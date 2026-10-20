import type { HoldPage, LockView, ObjectLock, SetLockOptions } from "@devultur/core";
import { extractId } from "@devultur/core";
import type { GenericActionCtx, GenericDataModel, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { actionGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import type { ComponentApi } from "./component/_generated/component.js";
import type { DevulturComponentConfig } from "./types";

type DevulturComponent = ComponentApi;
type QueryCtx = GenericQueryCtx<GenericDataModel>;
type MutationCtx = GenericMutationCtx<GenericDataModel>;
type ActionCtx = GenericActionCtx<GenericDataModel>;
type UploadUrlArgs = { filename: string; contentType: string; visibility?: "public" | "private" };

export class Devultur {
	private component: DevulturComponent;

	constructor(component: DevulturComponent) {
		this.component = component;
	}

	async getMedia(ctx: QueryCtx, key: string) {
		return ctx.runQuery(this.component.public.getMediaByKey, { key });
	}

	async saveProgress(ctx: MutationCtx, args: { userId: string; videoId: string; position: number }) {
		return ctx.runMutation(this.component.public.saveProgress, args);
	}

	async loadProgress(ctx: QueryCtx, args: { userId: string; videoId: string }) {
		return ctx.runQuery(this.component.public.loadProgress, args);
	}

	/** An upload URL from your server, optionally locked (retention and/or hold, written with the bytes). */
	async createUploadUrl(ctx: ActionCtx, args: UploadUrlArgs & { lock?: ObjectLock; hold?: boolean }) {
		return ctx.runAction(this.component.public.createUploadUrl, args);
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

	/** Releases `keys`' holds: a retention `period` starts now; without a retention they're free. */
	async releaseHold(ctx: ActionCtx, keys: string[]): Promise<Pick<HoldPage, "updated" | "skipped">> {
		return ctx.runAction(this.component.lock.releaseHold, { keys });
	}

	static exposeApi(component: DevulturComponent, config?: DevulturComponentConfig) {
		// No preset → the worker applies its config's default preset, or the HLS ladder if there is none.
		const preset = config?.video?.transcodePreset;
		const locales = config?.video?.captionLocales ?? [];

		// Optional per-resource visibility: override on upload / folder to delete on video.
		// Omitted → the component resolves the config's default (secure-by-default).
		const visibilityArg = v.optional(v.union(v.literal("public"), v.literal("private")));
		// The lock comes from the config only: a browser calling this never picks one.
		const uploadLock = config?.upload?.lock;

		return {
			issueViewerToken: actionGeneric({
				args: { sessionSecret: v.optional(v.string()) },
				handler: async (ctx: ActionCtx, args: { sessionSecret?: string }) => {
					return ctx.runAction(component.public.issueViewerToken, args);
				},
			}),

			createUploadUrl: actionGeneric({
				args: { filename: v.string(), contentType: v.string(), visibility: visibilityArg },
				handler: async (
					ctx: ActionCtx,
					args: { filename: string; contentType: string; visibility?: "public" | "private" },
				) => {
					return ctx.runAction(component.public.createUploadUrl, {
						...args,
						...(uploadLock ? { lock: uploadLock } : {}),
					});
				},
			}),

			deleteMedia: actionGeneric({
				args: { key: v.string() },
				handler: async (ctx: ActionCtx, args: { key: string }) => {
					return ctx.runAction(component.public.deleteMediaAction, args);
				},
			}),

			deleteVideo: actionGeneric({
				args: { videoId: v.string(), visibility: visibilityArg },
				handler: async (ctx: ActionCtx, args: { videoId: string; visibility?: "public" | "private" }) => {
					return ctx.runAction(component.public.deleteVideo, args);
				},
			}),

			processVideo: actionGeneric({
				args: { key: v.string() },
				handler: async (ctx: ActionCtx, args: { key: string }) => {
					return ctx.runAction(component.public.processVideo, {
						key: args.key,
						preset,
						locales,
					});
				},
			}),

			getMedia: queryGeneric({
				args: { key: v.string() },
				handler: async (ctx: QueryCtx, args: { key: string }) => {
					const mediaKey = args.key.includes("/") ? extractId(args.key) : args.key;
					return ctx.runQuery(component.public.getMediaByKey, { key: mediaKey });
				},
			}),

			saveProgress: mutationGeneric({
				args: { userId: v.string(), videoId: v.string(), position: v.number() },
				handler: async (ctx: MutationCtx, args: { userId: string; videoId: string; position: number }) => {
					return ctx.runMutation(component.public.saveProgress, args);
				},
			}),

			loadProgress: queryGeneric({
				args: { userId: v.string(), videoId: v.string() },
				handler: async (ctx: QueryCtx, args: { userId: string; videoId: string }) => {
					return ctx.runQuery(component.public.loadProgress, args);
				},
			}),

			markComplete: mutationGeneric({
				args: { userId: v.string(), videoId: v.string() },
				handler: async (ctx: MutationCtx, args: { userId: string; videoId: string }) => {
					return ctx.runMutation(component.public.markComplete, args);
				},
			}),

			resetProgress: mutationGeneric({
				args: { userId: v.string(), videoId: v.string() },
				handler: async (ctx: MutationCtx, args: { userId: string; videoId: string }) => {
					return ctx.runMutation(component.public.resetProgress, args);
				},
			}),
		};
	}
}
