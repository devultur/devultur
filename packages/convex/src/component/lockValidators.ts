// Validators of the object lock arguments (the shapes of `@devultur/core`'s `ObjectLock` and `SetLockOptions`).
import { v } from "convex/values";

export const retentionModeValidator = v.union(v.literal("governance"), v.literal("compliance"));
export const derivativesValidator = v.union(v.literal("inherit"), v.literal("original-only"));

export const objectLockValidator = v.object({
	retention: v.optional(
		v.object({
			mode: retentionModeValidator,
			until: v.optional(v.string()),
			period: v.optional(v.number()),
			derivatives: v.optional(derivativesValidator),
		}),
	),
	hold: v.optional(v.boolean()),
});
