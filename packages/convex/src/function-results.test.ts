// Type tests: what an app's `useQuery`, `useMutation` and `useAction` return for the functions `defineDevulturFunctions`
// and `Devultur.exposeApi` register. `component/_generated/component.ts` types every result `any`, so the results are
// checked here against the component's own handlers, with ids as the plain strings an app receives. `pnpm typecheck`
// fails when one of them drifts; vitest only runs the trivial bodies.
import type {
	ApiFromModules,
	FunctionArgs,
	FunctionReference,
	FunctionReturnType,
	FunctionType,
	FunctionVisibility,
	PaginationResult,
} from "convex/server";
import type { GenericId } from "convex/values";
import { describe, expectTypeOf, it } from "vitest";
import { Devultur } from "./client";
import type { ComponentApi } from "./component/_generated/component.js";
import type * as library from "./component/library";
import type * as metadata from "./component/metadata";
import type * as publicFunctions from "./component/public";
import type * as uploads from "./component/uploads";
import type { DevulturFunctionResults, MediaDocument, ProgressDocument } from "./function-results";
import { defineDevulturFunctions } from "./guarded-functions";
import type { MediaRecord } from "./types";

const component = {} as ComponentApi;
const guarded = defineDevulturFunctions(new Devultur(component), { guard: async () => {} });
const exposed = Devultur.exposeApi(component);

type GuardedApi = ApiFromModules<{ devultur: typeof guarded }>["devultur"];
type ExposedApi = ApiFromModules<{ devultur: typeof exposed }>["devultur"];
type Result<Name extends keyof GuardedApi> = FunctionReturnType<GuardedApi[Name]>;

// The component's functions as its handlers type them, and a result as it crosses into the app: ids become strings.
type Component = ApiFromModules<{
	library: typeof library;
	metadata: typeof metadata;
	public: typeof publicFunctions;
	uploads: typeof uploads;
}>;
type AsReceived<T> =
	T extends GenericId<string>
		? string
		: T extends (infer Item)[]
			? AsReceived<Item>[]
			: T extends object
				? { [Key in keyof T]: AsReceived<T[Key]> }
				: T;
type Handled<Reference extends FunctionReference<FunctionType, FunctionVisibility>> = AsReceived<
	FunctionReturnType<Reference>
>;

describe("the registered functions' results", () => {
	it("are the component's handlers' results", () => {
		expectTypeOf<Result<"issueViewerToken">>().toEqualTypeOf<Handled<Component["public"]["issueViewerToken"]>>();
		expectTypeOf<Result<"createUploadUrl">>().toEqualTypeOf<Handled<Component["public"]["createUploadUrl"]>>();
		expectTypeOf<Result<"confirmUpload">>().toEqualTypeOf<Handled<Component["uploads"]["confirmUpload"]>>();
		expectTypeOf<Result<"updateMediaMeta">>().toEqualTypeOf<Handled<Component["metadata"]["updateMediaMeta"]>>();
		expectTypeOf<Result<"deleteMedia">>().toEqualTypeOf<Handled<Component["public"]["deleteMediaAction"]>>();
		expectTypeOf<Result<"deleteVideo">>().toEqualTypeOf<Handled<Component["public"]["deleteVideo"]>>();
		expectTypeOf<Result<"processVideo">>().toEqualTypeOf<Handled<Component["public"]["processVideo"]>>();
		expectTypeOf<Result<"getMedia">>().toEqualTypeOf<Handled<Component["public"]["getMediaByKey"]>>();
		expectTypeOf<Result<"listMediaPage">>().toEqualTypeOf<Handled<Component["public"]["listMediaPage"]>>();
		expectTypeOf<Result<"searchMedia">>().toEqualTypeOf<Handled<Component["library"]["searchMedia"]>>();
		expectTypeOf<Result<"saveProgress">>().toEqualTypeOf<Handled<Component["public"]["saveProgress"]>>();
		expectTypeOf<Result<"loadProgress">>().toEqualTypeOf<Handled<Component["public"]["loadProgress"]>>();
		expectTypeOf<Result<"markComplete">>().toEqualTypeOf<Handled<Component["public"]["markComplete"]>>();
		expectTypeOf<Result<"resetProgress">>().toEqualTypeOf<Handled<Component["public"]["resetProgress"]>>();
	});

	it("name a result for every function, and only for those", () => {
		expectTypeOf<keyof DevulturFunctionResults>().toEqualTypeOf<keyof GuardedApi>();
	});

	it("type the media and progress records", () => {
		expectTypeOf<Result<"getMedia">>().toEqualTypeOf<MediaDocument | null>();
		expectTypeOf<Result<"getMedia">>().toExtend<MediaRecord | null>();
		expectTypeOf<Result<"listMediaPage">>().toEqualTypeOf<PaginationResult<MediaDocument>>();
		expectTypeOf<Result<"searchMedia">["page"][number]["_id"]>().toEqualTypeOf<string>();
		expectTypeOf<Result<"loadProgress">>().toEqualTypeOf<ProgressDocument | null>();
		expectTypeOf<Result<"issueViewerToken">>().toEqualTypeOf<{ token: string; expiresIn: number }>();
	});

	it("are the same from Devultur.exposeApi", () => {
		expectTypeOf<FunctionReturnType<ExposedApi["getMedia"]>>().toEqualTypeOf<MediaDocument | null>();
		expectTypeOf<FunctionReturnType<ExposedApi["confirmUpload"]>>().toEqualTypeOf<Result<"confirmUpload">>();
	});

	it("are the client's results too", () => {
		expectTypeOf<ReturnType<Devultur["getMedia"]>>().toEqualTypeOf<Promise<MediaDocument | null>>();
		expectTypeOf<ReturnType<Devultur["loadProgress"]>>().toEqualTypeOf<Promise<ProgressDocument | null>>();
		expectTypeOf<ReturnType<Devultur["saveProgress"]>>().toEqualTypeOf<Promise<string>>();
		expectTypeOf<ReturnType<Devultur["createUploadUrl"]>>().toEqualTypeOf<Promise<Result<"createUploadUrl">>>();
		expectTypeOf<ReturnType<Devultur["listMedia"]>>().toEqualTypeOf<
			Promise<AsReceived<FunctionReturnType<Component["public"]["listMedia"]>>>
		>();
	});

	it("keep the arguments", () => {
		expectTypeOf<FunctionArgs<GuardedApi["getMedia"]>>().toEqualTypeOf<{ key: string }>();
		expectTypeOf<FunctionArgs<GuardedApi["saveProgress"]>>().toEqualTypeOf<{
			userId: string;
			videoId: string;
			position: number;
		}>();
		expectTypeOf<FunctionArgs<ExposedApi["createUploadUrl"]>>().toEqualTypeOf<{
			filename: string;
			contentType: string;
			visibility?: "public" | "private";
		}>();
	});
});
