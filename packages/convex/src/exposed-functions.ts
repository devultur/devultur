// The functions an app exposes from the component, defined once: `Devultur.exposeApi` registers them as they are and
// `defineDevulturFunctions` registers them behind a guard, so both always expose the same set with the same arguments.
import { extractId } from "@devultur/core";
import type {
	DefaultFunctionArgs,
	FunctionVisibility,
	GenericActionCtx,
	GenericDataModel,
	GenericMutationCtx,
	GenericQueryCtx,
	RegisteredAction,
	RegisteredMutation,
	RegisteredQuery,
} from "convex/server";
import {
	actionGeneric,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	mutationGeneric,
	paginationOptsValidator,
	queryGeneric,
} from "convex/server";
import { type ObjectType, type PropertyValidators, v } from "convex/values";
import type { ComponentApi } from "./component/_generated/component.js";
import type { DevulturComponentConfig } from "./types";

export type FunctionKind = "query" | "mutation" | "action";

type ContextOf<Kind extends FunctionKind> = Kind extends "query"
	? GenericQueryCtx<GenericDataModel>
	: Kind extends "mutation"
		? GenericMutationCtx<GenericDataModel>
		: GenericActionCtx<GenericDataModel>;

/** What a guard tells the function about its caller. `userId` becomes the subject of `issueViewerToken`'s token. */
export interface CallerContext {
	userId?: string;
}

export interface ExposedFunction<Kind extends FunctionKind, Args extends DefaultFunctionArgs, Result> {
	kind: Kind;
	args: PropertyValidators;
	handler: (ctx: ContextOf<Kind>, args: Args, caller: CallerContext) => Promise<Result>;
}

// biome-ignore lint/suspicious/noExplicitAny: any function kind, args and result.
type AnyExposedFunction = ExposedFunction<FunctionKind, any, any>;

function exposed<Kind extends FunctionKind, Validators extends PropertyValidators, Result>(
	kind: Kind,
	args: Validators,
	handler: (ctx: ContextOf<Kind>, args: ObjectType<Validators>, caller: CallerContext) => Promise<Result>,
): ExposedFunction<Kind, ObjectType<Validators>, Result> {
	return { kind, args, handler };
}

const visibilityArg = v.optional(v.union(v.literal("public"), v.literal("private")));
const mediaTypeArg = v.optional(v.union(v.literal("video"), v.literal("image"), v.literal("file")));
const progressArgs = { userId: v.string(), videoId: v.string() };

export function exposedFunctions(component: ComponentApi, config?: DevulturComponentConfig) {
	// No preset → the worker applies its config's default preset, or the HLS ladder if there is none.
	const preset = config?.video?.transcodePreset;
	const locales = config?.video?.captionLocales ?? [];
	// The lock comes from the config only: a browser calling this never picks one.
	const uploadLock = config?.upload?.lock;

	return {
		issueViewerToken: exposed("action", { sessionSecret: v.optional(v.string()) }, async (ctx, args, caller) =>
			ctx.runAction(component.public.issueViewerToken, {
				...args,
				...(caller.userId ? { userId: caller.userId } : {}),
			}),
		),

		// Optional per-resource visibility; omitted → the component resolves the config's default (secure-by-default).
		createUploadUrl: exposed(
			"action",
			{ filename: v.string(), contentType: v.string(), visibility: visibilityArg },
			async (ctx, args) =>
				ctx.runAction(component.public.createUploadUrl, { ...args, ...(uploadLock ? { lock: uploadLock } : {}) }),
		),

		// Records an upload once its bytes are stored (the Worker HEADs the key): a browser can't list anything
		// that isn't in your bucket. `useDevultur().upload()` and `useMediaUpload` call it after the PUT.
		confirmUpload: exposed(
			"action",
			{
				key: v.string(),
				filename: v.optional(v.string()),
				width: v.optional(v.number()),
				height: v.optional(v.number()),
			},
			async (ctx, args) => ctx.runAction(component.uploads.confirmUpload, args),
		),

		deleteMedia: exposed("action", { key: v.string() }, async (ctx, args) =>
			ctx.runAction(component.public.deleteMediaAction, args),
		),

		deleteVideo: exposed("action", { videoId: v.string(), visibility: visibilityArg }, async (ctx, args) =>
			ctx.runAction(component.public.deleteVideo, args),
		),

		processVideo: exposed("action", { key: v.string() }, async (ctx, args) =>
			ctx.runAction(component.public.processVideo, { key: args.key, preset, locales }),
		),

		getMedia: exposed("query", { key: v.string() }, async (ctx, args) => {
			const mediaKey = args.key.includes("/") ? extractId(args.key) : args.key;
			return ctx.runQuery(component.public.getMediaByKey, { key: mediaKey });
		}),

		// The media library, a page at a time (for `usePaginatedQuery`). It lists every record, of every user.
		listMediaPage: exposed(
			"query",
			{ type: mediaTypeArg, paginationOpts: paginationOptsValidator },
			async (ctx, args) => ctx.runQuery(component.public.listMediaPage, args),
		),

		saveProgress: exposed("mutation", { ...progressArgs, position: v.number() }, async (ctx, args) =>
			ctx.runMutation(component.public.saveProgress, args),
		),

		loadProgress: exposed("query", progressArgs, async (ctx, args) =>
			ctx.runQuery(component.public.loadProgress, args),
		),

		markComplete: exposed("mutation", progressArgs, async (ctx, args) =>
			ctx.runMutation(component.public.markComplete, args),
		),

		resetProgress: exposed("mutation", progressArgs, async (ctx, args) =>
			ctx.runMutation(component.public.resetProgress, args),
		),
	};
}

export type ExposedFunctions = ReturnType<typeof exposedFunctions>;
export type ExposedFunctionName = keyof ExposedFunctions;

type Registered<Fn, Visibility extends FunctionVisibility> =
	Fn extends ExposedFunction<"query", infer Args, infer Result>
		? RegisteredQuery<Visibility, Args, Promise<Result>>
		: Fn extends ExposedFunction<"mutation", infer Args, infer Result>
			? RegisteredMutation<Visibility, Args, Promise<Result>>
			: Fn extends ExposedFunction<"action", infer Args, infer Result>
				? RegisteredAction<Visibility, Args, Promise<Result>>
				: never;

/** The Convex functions registered from `ExposedFunctions`, each with its own args and result. */
export type RegisteredFunctions<Visibility extends FunctionVisibility> = {
	[Name in ExposedFunctionName]: Registered<ExposedFunctions[Name], Visibility>;
};

const BUILDERS = {
	public: { query: queryGeneric, mutation: mutationGeneric, action: actionGeneric },
	internal: { query: internalQueryGeneric, mutation: internalMutationGeneric, action: internalActionGeneric },
} as const;

type RegisteredHandler = (ctx: never, args: DefaultFunctionArgs) => Promise<unknown>;

/** Registers every function with the builder of its kind and `visibility`; `wrap` returns the handler to register. */
export function registerFunctions<Visibility extends FunctionVisibility>(
	functions: ExposedFunctions,
	visibility: Visibility,
	wrap: (name: ExposedFunctionName, fn: AnyExposedFunction) => RegisteredHandler,
): RegisteredFunctions<Visibility> {
	const entries = Object.entries(functions).map(([name, fn]) => {
		const builder = BUILDERS[visibility][fn.kind] as (definition: object) => unknown;
		return [name, builder({ args: fn.args, handler: wrap(name as ExposedFunctionName, fn) })];
	});
	return Object.fromEntries(entries) as RegisteredFunctions<Visibility>;
}
