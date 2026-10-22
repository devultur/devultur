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

/** The ctx of the guarded function: a query's, a mutation's or an action's (all of them have `auth`). */
export type DevulturGuardCtx =
	| GenericQueryCtx<GenericDataModel>
	| GenericMutationCtx<GenericDataModel>
	| GenericActionCtx<GenericDataModel>;

/**
 * Throws to deny the call. May return what it learned about the caller: a `userId` becomes the subject of the token
 * `issueViewerToken` issues, and the only user the progress functions act for (another `userId` in their arguments is
 * refused with `user_mismatch`, unless the guard also returns `canActForOthers: true`).
 */
export type DevulturGuard = (ctx: DevulturGuardCtx, operation: DevulturOperation) => GuardResult | Promise<GuardResult>;

// `void`: a guard that only checks (and throws) returns nothing, including one typed `() => void`.
// biome-ignore lint/suspicious/noConfusingVoidType: see above.
type GuardResult = CallerContext | undefined | void;

export interface DevulturFunctionsOptions<Visibility extends FunctionVisibility> {
	guard: DevulturGuard;
	/** `"internal"` registers them as internal functions (callable from your server only). Default `"public"`. */
	visibility?: Visibility;
	/** Same as `Devultur.exposeApi`'s: the transcode preset, caption locales and upload lock. */
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
			const caller = (await guard(ctx as DevulturGuardCtx, operation)) ?? {};
			return fn.handler(ctx, args, caller);
		};
	});
}
