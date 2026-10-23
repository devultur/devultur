import type {
	ApiFromModules,
	FilterApi,
	FunctionArgs,
	FunctionReference,
	GenericActionCtx,
	GenericDataModel,
} from "convex/server";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { Devultur } from "./client";
import type { ComponentApi } from "./component/_generated/component.js";
import {
	type DevulturArgsRewrite,
	type DevulturGuardResult,
	type DevulturOperation,
	defineDevulturFunctions,
} from "./guarded-functions";
import type { DevulturUploadConfig } from "./types";

// The builders return their definition, tagged with kind and visibility, so a test can call the handler.
vi.mock("convex/server", async (importOriginal) => {
	const original = await importOriginal<typeof import("convex/server")>();
	const builder = (kind: string, visibility: string) => (definition: object) => ({ ...definition, kind, visibility });
	return {
		...original,
		queryGeneric: builder("query", "public"),
		mutationGeneric: builder("mutation", "public"),
		actionGeneric: builder("action", "public"),
		internalQueryGeneric: builder("query", "internal"),
		internalMutationGeneric: builder("mutation", "internal"),
		internalActionGeneric: builder("action", "internal"),
	};
});

interface TestDefinition {
	kind: string;
	visibility: string;
	handler: (ctx: unknown, args: unknown) => Promise<unknown>;
}

// Function references are opaque to the handlers: each one is its own path, so a spy can tell which was called.
const component = new Proxy(
	{},
	{ get: (_, module) => new Proxy({}, { get: (_, fn) => `${String(module)}.${String(fn)}` }) },
);
const devultur = new Devultur(component as ComponentApi);

function fakeCtx() {
	const run = vi.fn(async (reference: string, args: unknown) => ({ reference, args }));
	return { ctx: { runAction: run, runQuery: run, runMutation: run, auth: {} }, run };
}

function definitionOf(functions: object, name: string): TestDefinition {
	return (functions as Record<string, TestDefinition>)[name];
}

const ARGS_BY_NAME: Record<string, Record<string, unknown>> = {
	issueViewerToken: { sessionSecret: "secret" },
	createUploadUrl: { filename: "a.png", contentType: "image/png" },
	confirmUpload: { key: "private/image/id/a.png" },
	updateMediaMeta: { key: "id", title: "Cover", tags: ["landscape"] },
	deleteMedia: { key: "id" },
	deleteVideo: { videoId: "id" },
	processVideo: { key: "private/video/id/raw/a.mp4" },
	getMedia: { key: "id" },
	listMediaPage: { paginationOpts: { numItems: 10, cursor: null } },
	searchMedia: { search: "cover", type: "image", paginationOpts: { numItems: 10, cursor: null } },
	saveProgress: { userId: "u", videoId: "v", position: 3 },
	loadProgress: { userId: "u", videoId: "v" },
	markComplete: { userId: "u", videoId: "v" },
	resetProgress: { userId: "u", videoId: "v" },
};

describe("defineDevulturFunctions", () => {
	it("defines exactly exposeApi's functions, with the same kinds", () => {
		const exposed = Devultur.exposeApi(component as ComponentApi);
		const guarded = defineDevulturFunctions(devultur, { guard: () => {} });
		expect(Object.keys(guarded).sort()).toEqual(Object.keys(exposed).sort());
		expect(Object.keys(guarded).sort()).toEqual(Object.keys(ARGS_BY_NAME).sort());
		for (const name of Object.keys(exposed)) {
			expect(definitionOf(guarded, name).kind).toBe(definitionOf(exposed, name).kind);
		}
	});

	it.each(Object.keys(ARGS_BY_NAME))("guards %s before it runs, with its name, kind and args", async (name) => {
		const { ctx, run } = fakeCtx();
		const guard = vi.fn(() => {
			expect(run).not.toHaveBeenCalled();
		});
		const definition = definitionOf(defineDevulturFunctions(devultur, { guard }), name);
		await definition.handler(ctx, ARGS_BY_NAME[name]);
		expect(guard).toHaveBeenCalledWith(ctx, { name, kind: definition.kind, args: ARGS_BY_NAME[name] });
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("doesn't run the function when the guard throws", async () => {
		const { ctx, run } = fakeCtx();
		const guard = vi.fn(async () => {
			throw new Error("denied");
		});
		const { confirmUpload } = defineDevulturFunctions(devultur, { guard });
		await expect(definitionOf({ confirmUpload }, "confirmUpload").handler(ctx, { key: "k" })).rejects.toThrow("denied");
		expect(run).not.toHaveBeenCalled();
	});

	it("passes the guard's userId to issueViewerToken as the token's subject", async () => {
		const { ctx, run } = fakeCtx();
		const { issueViewerToken } = defineDevulturFunctions(devultur, { guard: async () => ({ userId: "user-1" }) });
		await definitionOf({ issueViewerToken }, "issueViewerToken").handler(ctx, { sessionSecret: "s" });
		expect(run).toHaveBeenCalledWith("public.issueViewerToken", { sessionSecret: "s", userId: "user-1" });
	});

	it("issues the shared subject when the guard returns nothing, as exposeApi does", async () => {
		const { ctx, run } = fakeCtx();
		const { issueViewerToken } = defineDevulturFunctions(devultur, { guard: () => undefined });
		await definitionOf({ issueViewerToken }, "issueViewerToken").handler(ctx, { sessionSecret: "s" });
		expect(run).toHaveBeenCalledWith("public.issueViewerToken", { sessionSecret: "s" });
	});

	it("doesn't edit metadata when the guard denies it, and edits by media id", async () => {
		const { ctx, run } = fakeCtx();
		const denied = defineDevulturFunctions(devultur, {
			guard: () => {
				throw new Error("denied");
			},
		});
		await expect(definitionOf(denied, "updateMediaMeta").handler(ctx, { key: "id", title: "x" })).rejects.toThrow(
			"denied",
		);
		expect(run).not.toHaveBeenCalled();

		const allowed = defineDevulturFunctions(devultur, { guard: () => {} });
		await definitionOf(allowed, "updateMediaMeta").handler(ctx, { key: "public/image/abc123/a.png", alt: "A" });
		expect(run).toHaveBeenCalledWith("metadata.updateMediaMeta", { key: "abc123", alt: "A" });
	});

	const PROGRESS_FUNCTIONS = ["saveProgress", "loadProgress", "markComplete", "resetProgress"];

	it.each(PROGRESS_FUNCTIONS)("refuses %s for another user than the guard's", async (name) => {
		const { ctx, run } = fakeCtx();
		const functions = defineDevulturFunctions(devultur, { guard: async () => ({ userId: "user-1" }) });
		const otherUsersArgs = { ...ARGS_BY_NAME[name], userId: "user-2" };

		await expect(definitionOf(functions, name).handler(ctx, otherUsersArgs)).rejects.toMatchObject({
			data: { code: "user_mismatch", status: 403 },
		});
		expect(run).not.toHaveBeenCalled();
	});

	it.each(PROGRESS_FUNCTIONS)("runs %s for the guard's own user", async (name) => {
		const { ctx, run } = fakeCtx();
		const functions = defineDevulturFunctions(devultur, { guard: async () => ({ userId: "user-1" }) });
		const ownArgs = { ...ARGS_BY_NAME[name], userId: "user-1" };

		await definitionOf(functions, name).handler(ctx, ownArgs);
		expect(run).toHaveBeenCalledWith(expect.any(String), ownArgs);
	});

	it("runs the progress functions for any user when the guard can act for others", async () => {
		const { ctx, run } = fakeCtx();
		const guard = async () => ({ userId: "admin", canActForOthers: true });
		const { resetProgress } = defineDevulturFunctions(devultur, { guard });
		const args = { userId: "learner", videoId: "v" };

		await definitionOf({ resetProgress }, "resetProgress").handler(ctx, args);
		expect(run).toHaveBeenCalledWith("public.resetProgress", args);
	});

	it("keeps the browser's userId when the guard returns none, as exposeApi does", async () => {
		const { ctx, run } = fakeCtx();
		const { loadProgress } = defineDevulturFunctions(devultur, { guard: () => {} });
		await definitionOf({ loadProgress }, "loadProgress").handler(ctx, { userId: "u", videoId: "v" });
		expect(run).toHaveBeenCalledWith("public.loadProgress", { userId: "u", videoId: "v" });
	});

	it("searches the library through the component's searchMedia, behind the guard", async () => {
		const { ctx, run } = fakeCtx();
		const guard = vi.fn(() => {});
		const args = ARGS_BY_NAME.searchMedia;
		await definitionOf(defineDevulturFunctions(devultur, { guard }), "searchMedia").handler(ctx, args);
		expect(guard).toHaveBeenCalledWith(ctx, { name: "searchMedia", kind: "query", args });
		expect(run).toHaveBeenCalledWith("library.searchMedia", args);
	});

	it("registers internal functions with visibility: internal", () => {
		const functions = defineDevulturFunctions(devultur, { guard: () => {}, visibility: "internal" });
		expect(definitionOf(functions, "getMedia").visibility).toBe("internal");
		expect(definitionOf(defineDevulturFunctions(devultur, { guard: () => {} }), "getMedia").visibility).toBe("public");
	});

	it("keeps each function's kind, visibility and args in the app's api", () => {
		const functions = defineDevulturFunctions(devultur, { guard: () => {} });
		const internal = defineDevulturFunctions(devultur, { guard: () => {}, visibility: "internal" });
		type Api = ApiFromModules<{ devultur: typeof functions }>;
		type InternalApi = FilterApi<ApiFromModules<{ devultur: typeof internal }>, FunctionReference<"query", "internal">>;
		type ExposedApi = ApiFromModules<{ devultur: ReturnType<typeof Devultur.exposeApi> }>;

		expectTypeOf<FunctionArgs<Api["devultur"]["confirmUpload"]>>().toEqualTypeOf<{
			key: string;
			filename?: string;
			width?: number;
			height?: number;
			pageCount?: number;
		}>();
		expectTypeOf<FunctionArgs<Api["devultur"]["updateMediaMeta"]>>().toEqualTypeOf<{
			key: string;
			title?: string;
			alt?: string;
			tags?: string[];
		}>();
		expectTypeOf<Api["devultur"]["updateMediaMeta"]["_type"]>().toEqualTypeOf<"mutation">();
		expectTypeOf<Api["devultur"]["confirmUpload"]["_type"]>().toEqualTypeOf<"action">();
		expectTypeOf<Api["devultur"]["getMedia"]["_visibility"]>().toEqualTypeOf<"public">();
		expectTypeOf<FunctionArgs<InternalApi["devultur"]["getMedia"]>>().toEqualTypeOf<{ key: string }>();
		expectTypeOf<InternalApi["devultur"]["getMedia"]["_visibility"]>().toEqualTypeOf<"internal">();
		expectTypeOf<FunctionArgs<Api["devultur"]["saveProgress"]>>().toEqualTypeOf<
			FunctionArgs<ExposedApi["devultur"]["saveProgress"]>
		>();
	});

	it("types the guard's operation by name", () => {
		expectTypeOf<Extract<DevulturOperation, { name: "confirmUpload" }>["kind"]>().toEqualTypeOf<"action">();
		expectTypeOf<Extract<DevulturOperation, { name: "getMedia" }>["args"]>().toEqualTypeOf<{ key: string }>();
		expectTypeOf<Parameters<typeof defineDevulturFunctions>[1]["guard"]>()
			.parameter(0)
			.toExtend<GenericActionCtx<GenericDataModel> | object>();
	});
});

describe("upload visibility", () => {
	const uploadArgs = { filename: "a.png", contentType: "image/png" };
	const createUploadUrlOf = (functions: object) => definitionOf(functions, "createUploadUrl");

	it("lets the Worker pick the default when neither the caller nor the config sets one", async () => {
		const { ctx, run } = fakeCtx();
		await createUploadUrlOf(Devultur.exposeApi(component as ComponentApi)).handler(ctx, uploadArgs);
		expect(run).toHaveBeenCalledWith("public.createUploadUrl", uploadArgs);
	});

	it("uses config.upload.visibility when the caller passes none", async () => {
		const { ctx, run } = fakeCtx();
		const exposed = Devultur.exposeApi(component as ComponentApi, { upload: { visibility: "public" } });
		await createUploadUrlOf(exposed).handler(ctx, uploadArgs);
		expect(run).toHaveBeenCalledWith("public.createUploadUrl", { ...uploadArgs, visibility: "public" });
	});

	it("keeps the caller's visibility over the config's", async () => {
		const { ctx, run } = fakeCtx();
		const config = { upload: { visibility: "public" as const } };
		const guarded = defineDevulturFunctions(devultur, { guard: () => {}, config });
		await createUploadUrlOf(guarded).handler(ctx, { ...uploadArgs, visibility: "private" });
		expect(run).toHaveBeenCalledWith("public.createUploadUrl", { ...uploadArgs, visibility: "private" });
	});

	it("applies the guard's rewrite over the caller's and the config's", async () => {
		const { ctx, run } = fakeCtx();
		const guarded = defineDevulturFunctions(devultur, {
			guard: (_ctx, operation) => {
				if (operation.name !== "createUploadUrl") return;
				const args = { visibility: "private" as const, filename: `team-${operation.args.filename}` };
				return { rewrite: { name: "createUploadUrl", args } };
			},
			config: { upload: { visibility: "public", lock: { hold: true } } },
		});
		await createUploadUrlOf(guarded).handler(ctx, { ...uploadArgs, visibility: "public" });
		expect(run).toHaveBeenCalledWith("public.createUploadUrl", {
			filename: "team-a.png",
			contentType: "image/png",
			visibility: "private",
			lock: { hold: true },
		});
	});

	it("shows the guard the caller's own args, before the config's default", async () => {
		const { ctx } = fakeCtx();
		const guard = vi.fn(() => {});
		const config = { upload: { visibility: "public" as const } };
		await createUploadUrlOf(defineDevulturFunctions(devultur, { guard, config })).handler(ctx, uploadArgs);
		expect(guard).toHaveBeenCalledWith(ctx, { name: "createUploadUrl", kind: "action", args: uploadArgs });
	});

	it("rewrites any operation's args, and keeps the rewrite out of the caller context", async () => {
		const { ctx, run } = fakeCtx();
		const guarded = defineDevulturFunctions(devultur, {
			guard: () => ({
				userId: "user-1",
				rewrite: { name: "issueViewerToken", args: { sessionSecret: "server-secret" } },
			}),
		});
		await definitionOf(guarded, "issueViewerToken").handler(ctx, { sessionSecret: "browser-secret" });
		expect(run).toHaveBeenCalledWith("public.issueViewerToken", { sessionSecret: "server-secret", userId: "user-1" });
	});

	it("throws when the rewrite names another operation, without running the function", async () => {
		const { ctx, run } = fakeCtx();
		const guarded = defineDevulturFunctions(devultur, {
			guard: () => ({ rewrite: { name: "createUploadUrl", args: { visibility: "private" } } }),
		});
		await expect(definitionOf(guarded, "deleteMedia").handler(ctx, { key: "id" })).rejects.toThrow(
			"rewrote createUploadUrl's arguments while guarding deleteMedia",
		);
		expect(run).not.toHaveBeenCalled();
	});

	it("refuses a rewritten media key that isn't a string with invalid_key", async () => {
		const { ctx, run } = fakeCtx();
		const guarded = defineDevulturFunctions(devultur, {
			guard: () => ({ rewrite: { name: "getMedia", args: { key: 42 as never } } }),
		});
		await expect(definitionOf(guarded, "getMedia").handler(ctx, { key: "id" })).rejects.toMatchObject({
			data: { code: "invalid_key", status: 400 },
		});
		expect(run).not.toHaveBeenCalled();
	});

	it("types the rewrite's args by its operation's name", () => {
		expectTypeOf<{
			rewrite: { name: "createUploadUrl"; args: { visibility: "private" } };
		}>().toExtend<DevulturGuardResult>();
		// Without the operation's name, the arguments can't be checked: a type error.
		expectTypeOf<{ rewrite: { args: { visibility: "private" } } }>().not.toExtend<DevulturGuardResult>();
		expectTypeOf<{ args: { visibility: "private" } }>().not.toExtend<DevulturArgsRewrite>();
		// Another operation's argument, or a wrong type, doesn't fit the named operation.
		expectTypeOf<{ rewrite: { name: "createUploadUrl"; args: { position: 3 } } }>().not.toExtend<DevulturGuardResult>();
		expectTypeOf<{
			rewrite: { name: "createUploadUrl"; args: { visibility: "secret" } };
		}>().not.toExtend<DevulturGuardResult>();
		expectTypeOf<DevulturUploadConfig["visibility"]>().toEqualTypeOf<"public" | "private" | undefined>();
	});
});
