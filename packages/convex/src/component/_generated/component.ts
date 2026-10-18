/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    public: {
      createMedia: FunctionReference<
        "mutation",
        "internal",
        {
          contentType: string;
          filename: string;
          key: string;
          sizeBytes: number;
          type: "video" | "image" | "file";
        },
        any,
        Name
      >;
      createUploadUrl: FunctionReference<
        "action",
        "internal",
        { contentType: string; filename: string },
        any,
        Name
      >;
      deleteMediaAction: FunctionReference<
        "action",
        "internal",
        { key: string },
        any,
        Name
      >;
      deleteVideo: FunctionReference<
        "action",
        "internal",
        { videoId: string },
        any,
        Name
      >;
      getCourseProgress: FunctionReference<
        "query",
        "internal",
        { userId: string; videoIds: Array<string> },
        any,
        Name
      >;
      getMediaByKey: FunctionReference<
        "query",
        "internal",
        { key: string },
        any,
        Name
      >;
      issueViewerToken: FunctionReference<"action", "internal", { sessionSecret?: string }, any, Name>;
      listCaptionsByMedia: FunctionReference<
        "query",
        "internal",
        { mediaKey: string },
        any,
        Name
      >;
      listMedia: FunctionReference<
        "query",
        "internal",
        { type?: "video" | "image" | "file" },
        any,
        Name
      >;
      loadProgress: FunctionReference<
        "query",
        "internal",
        { userId: string; videoId: string },
        any,
        Name
      >;
      markComplete: FunctionReference<
        "mutation",
        "internal",
        { userId: string; videoId: string },
        any,
        Name
      >;
      processVideo: FunctionReference<
        "action",
        "internal",
        {
          callbackUrl?: string;
          key: string;
          locales?: Array<string>;
          preset?: string;
        },
        any,
        Name
      >;
      resetProgress: FunctionReference<
        "mutation",
        "internal",
        { userId: string; videoId: string },
        any,
        Name
      >;
      saveProgress: FunctionReference<
        "mutation",
        "internal",
        { position: number; userId: string; videoId: string },
        any,
        Name
      >;
      updateMedia: FunctionReference<
        "mutation",
        "internal",
        {
          captionLocales?: Array<string>;
          duration?: number;
          key: string;
          playlistUrl?: string;
          thumbnailKey?: string;
          transcodeError?: string;
          transcodeProgress?: { current: number; total: number };
          transcodeStatus?: "transcoding" | "captioning" | "ready" | "failed";
        },
        any,
        Name
      >;
      upsertCaption: FunctionReference<
        "mutation",
        "internal",
        { locale: string; mediaKey: string; srtUrl?: string; vttUrl: string },
        any,
        Name
      >;
    };
  };
