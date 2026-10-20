import type { DevulturKind } from "@devultur/core";
import { v } from "convex/values";

// Fields of a `DevulturMedia` as a Convex validator. The reference is stored typed and validated
// (not a `v.string()` that accepts anything): a malformed media is rejected in the mutation,
// not in the `<img>`. The shape is identical to `DevulturMedia` from @devultur/core → the doc infers the type.
const mediaFields = {
	id: v.string(),
	visibility: v.union(v.literal("public"), v.literal("private")),
	filename: v.optional(v.string()),
	// The uploaded object's key, as `upload()` returns it. Optional: references stored before it stay valid.
	key: v.optional(v.string()),
	width: v.optional(v.number()),
	height: v.optional(v.number()),
} as const;

/**
 * Convex validator for a typed media reference. `dv.media()` accepts any kind;
 * `dv.media("image")` restricts the `kind`. Store the reference, not the URL:
 *
 * @example
 * // convex/schema.ts
 * import { dv } from "@devultur/convex";
 * courses: defineTable({ thumbnail: dv.media("image").optional() });
 */
export const dv = {
	media(kind?: DevulturKind) {
		return v.object({
			...mediaFields,
			kind: kind ? v.literal(kind) : v.union(v.literal("image"), v.literal("video"), v.literal("file")),
		});
	},
};
