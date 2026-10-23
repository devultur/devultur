// The component's exposed functions behind the app's guard: every handler awaits `guard(ctx, operation)` first, so a
// function can't be exported without the app's auth check. The set and the arguments are `Devultur.exposeApi`'s.
//
// ```ts
// export const { createUploadUrl, confirmUpload, issueViewerToken } = defineDevulturFunctions(devultur, {
//   guard: async (ctx, { name }) => {
//     const identity = await ctx.auth.getUserIdentity();
//     if (!identity) throw new ConvexError("Sign in first");
//     return { userId: identity.subject };
//   },
// });
// ```
import type {
	DefaultFunctionArgs,
	FunctionVisibility,
	GenericActionCtx,
	GenericDataModel,
	GenericMutationCtx,
	GenericQueryCtx,
} from "convex/server";
import type { Devultur } from "./client";
import {
	type CallerContext,
	type ExposedFunctionName,
	type ExposedFunctions,
	exposedFunctions,
	type RegisteredFunctions,
	registerFunctions,
} from "./exposed-functions";
import type { DevulturComponentConfig } from "./types";

type ArgsOf<Fn> = Fn extends { handler: (ctx: never, args: infer Args, caller: never) => unknown } ? Args : never;

/** One call to guard: which function, of which kind, with the caller's arguments. Narrow on `name`. */
export type DevulturOperation = {
	[Name in ExposedFunctionName]: {
		name: Name;
		kind: ExposedFunctions[Name]["kind"];
		args: ArgsOf<ExposedFunctions[Name]>;
	};
}[ExposedFunctionName];

/**
 * The ctx of the guarded function: a query's, a mutation's or an action's (all of them have `auth`). Of any data
 * model, so a guard typed with the app's own ctx (`QueryCtx | MutationCtx | ActionCtx` from `_generated/server`) fits.
 */
// biome-ignore lint/suspicious/noExplicitAny: the app's data model, which the component can't name.
export type DevulturGuardCtx<DataModel extends GenericDataModel = any> =
	| GenericQueryCtx<DataModel>
	| GenericMutationCtx<DataModel>
	| GenericActionCtx<DataModel>;

/**
 * Throws to deny the call. May return what it learned about the caller: a `userId` becomes the subject of the token
 * `issueViewerToken` issues, and the only user the progress functions act for (another `userId` in their arguments is
 * refused with `user_mismatch`, unless the guard also returns `canActForOthers: true`). May also return a `rewrite` of
 * the caller's arguments (see `DevulturArgsRewrite`).
 */
export type DevulturGuard = (
	ctx: DevulturGuardCtx,
	operation: DevulturOperation,
) => DevulturGuardResult | Promise<DevulturGuardResult>;

/**
 * Arguments a guard rewrites, on your server, before the function runs: each key of `args` replaces the caller's
 * argument of that name. `name` is the operation's, so `args` are typed for it:
 * `{ name: "createUploadUrl", args: { visibility: "private" } }` uploads privately whatever the browser asked for.
 * A rewrite named for another operation than the one being guarded throws. The rewritten arguments aren't validated
 * again.
 */
export type DevulturArgsRewrite = {
	[Name in ExposedFunctionName]: { name: Name; args: Partial<ArgsOf<ExposedFunctions[Name]>> };
}[ExposedFunctionName];

/** What a guard returns: what it learned about the caller, and the arguments it rewrites. */
export type DevulturGuardResult =
	| (CallerContext & { rewrite?: DevulturArgsRewrite })
	| undefined
	// `void`: a guard that only checks (and throws) returns nothing, including one typed `() => void`.
	// biome-ignore lint/suspicious/noConfusingVoidType: see above.
	| void;

export interface DevulturFunctionsOptions<Visibility extends FunctionVisibility> {
	guard: DevulturGuard;
	/** `"internal"` registers them as internal functions (callable from your server only). Default `"public"`. */
	visibility?: Visibility;
	/** Same as `Devultur.exposeApi`'s: the transcode preset, caption locales, upload lock and default visibility. */
	config?: DevulturComponentConfig;
}

/** `Devultur.exposeApi`'s functions, each calling `options.guard` before it runs. Export the ones your app uses. */
export function defineDevulturFunctions<Visibility extends FunctionVisibility = "public">(
	devultur: Devultur,
	options: DevulturFunctionsOptions<Visibility>,
): RegisteredFunctions<Visibility> {
	const { guard, config } = options;
	const visibility = options.visibility ?? ("public" as Visibility);
	return registerFunctions(exposedFunctions(devultur.component, config), visibility, (name, fn) => {
		return async (ctx, args) => {
			const operation = { name, kind: fn.kind, args } as DevulturOperation;
			const { rewrite, ...caller } = (await guard(ctx as DevulturGuardCtx, operation)) ?? {};
			return fn.handler(ctx, rewrittenArgs(name, args, rewrite), caller);
		};
	});
}

function rewrittenArgs(name: ExposedFunctionName, args: DefaultFunctionArgs, rewrite?: DevulturArgsRewrite) {
	if (!rewrite) return args;
	if (rewrite.name !== name) {
		throw new Error(`The guard rewrote ${rewrite.name}'s arguments while guarding ${name}`);
	}
	return { ...args, ...rewrite.args };
}
