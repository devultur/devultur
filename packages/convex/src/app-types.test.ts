// Type tests: the package's types against an app's own, as `tsc` checks them in a consumer (a concrete `DataModel`,
// the references `defineDevulturFunctions` returns, the records the component stores). `pnpm typecheck` fails when
// one of them stops compiling; vitest only runs the trivial bodies.
import type {
	ApiFromModules,
	DataModelFromSchemaDefinition,
	FunctionReference,
	GenericActionCtx,
	GenericMutationCtx,
	GenericQueryCtx,
} from "convex/server";
import { defineSchema, defineTable } from "convex/server";
import { type Infer, v } from "convex/values";
import { describe, expectTypeOf, it } from "vitest";
import { Devultur } from "./client";
import type { ComponentApi } from "./component/_generated/component.js";
import type schema from "./component/schema";
import { defineDevulturFunctions } from "./guarded-functions";
import type { ViewerTokenAction } from "./media-session";
import type { MediaRecord } from "./types";

const appSchema = defineSchema({
	courses: defineTable({ title: v.string(), ownerId: v.string() }).index("by_owner", ["ownerId"]),
});
type DataModel = DataModelFromSchemaDefinition<typeof appSchema>;
type QueryCtx = GenericQueryCtx<DataModel>;
type MutationCtx = GenericMutationCtx<DataModel>;
type ActionCtx = GenericActionCtx<DataModel>;

declare const devultur: Devultur;
declare const queryCtx: QueryCtx;
declare const mutationCtx: MutationCtx;
declare const actionCtx: ActionCtx;

// Never called: only compiled.
async function appCalls() {
	await devultur.getMedia(queryCtx, "id");
	await devultur.listMediaPage(queryCtx, { paginationOpts: { numItems: 10, cursor: null } });
	await devultur.saveProgress(mutationCtx, { userId: "u", videoId: "v", position: 1 });
	await devultur.updateMediaMeta(mutationCtx, { key: "id", title: "Cover" });
	await devultur.createUploadUrl(actionCtx, { filename: "a.png", contentType: "image/png" });
	await devultur.confirmUpload(actionCtx, { key: "private/image/id/a.png" });
	await devultur.setHold(actionCtx, ["k"]);
	// An action reads through `runQuery`, like a query does.
	await devultur.getMedia(actionCtx, "id");
	// @ts-expect-error a query can't run an action
	await devultur.createUploadUrl(queryCtx, { filename: "a.png", contentType: "image/png" });
}

const functions = defineDevulturFunctions(new Devultur({} as ComponentApi), {
	guard: async (ctx: QueryCtx | MutationCtx | ActionCtx, operation) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error(`Sign in to call ${operation.name}`);
		return { userId: identity.subject };
	},
});

describe("an app's types", () => {
	it("passes its own ctx to the client's methods", () => {
		expectTypeOf(appCalls).toBeFunction();
	});

	it("passes the generated issueViewerToken to the viewer providers", () => {
		// What `api.devultur.issueViewerToken` is in the app once `functions.issueViewerToken` is exported.
		type Api = ApiFromModules<{ devultur: typeof functions }>;
		expectTypeOf<Api["devultur"]["issueViewerToken"]>().toExtend<ViewerTokenAction>();
		// An app's own action that requires the secret (and takes `tokenArgs`) still fits.
		expectTypeOf<
			FunctionReference<"action", "public", { sessionSecret: string; workspaceId: string }>
		>().toExtend<ViewerTokenAction>();
	});

	it("types every field the component stores on a media record", () => {
		type Stored = Infer<typeof schema.tables.media.validator>;
		expectTypeOf<MediaRecord>().toEqualTypeOf<Stored>();
		expectTypeOf<MediaRecord["failureReason"]>().toEqualTypeOf<
			"invalid_input" | "unsupported_codec" | "timeout" | "capacity" | "internal" | undefined
		>();
		expectTypeOf<NonNullable<MediaRecord["transcodeProgress"]>["phase"]>().toEqualTypeOf<
			"downloading" | "encoding" | "uploading" | "captioning" | undefined
		>();
		expectTypeOf<MediaRecord>().toHaveProperty("posterUrls");
		expectTypeOf<MediaRecord>().toHaveProperty("renditions");
		expectTypeOf<MediaRecord>().toHaveProperty("hasAudio");
		expectTypeOf<MediaRecord>().toHaveProperty("retriable");
	});
});
