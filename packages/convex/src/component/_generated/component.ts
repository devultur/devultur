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
    lock: {
      getLock: FunctionReference<
        "action",
        "internal",
        { key: string },
        any,
        Name
      >;
      releaseHold: FunctionReference<
        "action",
        "internal",
        { keys: Array<string> },
        any,
        Name
      >;
      setHold: FunctionReference<
        "action",
        "internal",
        { keys: Array<string> },
        any,
        Name
      >;
      setLock: FunctionReference<
        "action",
        "internal",
        {
          bypassGovernance?: boolean;
          derivatives?: "inherit" | "original-only";
          key: string;
          mode?: "governance" | "compliance";
          period?: number;
          remove?: true;
          until?: string;
        },
        any,
        Name
      >;
    };
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
        {
          contentType: string;
          filename: string;
          hold?: boolean;
          lock?: {
            hold?: boolean;
            retention?: {
              derivatives?: "inherit" | "original-only";
              mode: "governance" | "compliance";
              period?: number;
              until?: string;
            };
          };
          visibility?: "public" | "private";
        },
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
        { videoId: string; visibility?: "public" | "private" },
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
      issueViewerToken: FunctionReference<
        "action",
        "internal",
        { sessionSecret?: string },
        any,
        Name
      >;
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
      listMediaPage: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          type?: "video" | "image" | "file";
        },
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
          captionsPending?: boolean;
          duration?: number;
          failureReason?:
            | "invalid_input"
            | "unsupported_codec"
            | "timeout"
            | "capacity"
            | "internal";
          key: string;
          playlistUrl?: string;
          retriable?: boolean;
          thumbnailKey?: string;
          transcodeError?: string;
          transcodeProgress?: { current: number; total: number };
          transcodeStatus?:
            | "queued"
            | "transcoding"
            | "captioning"
            | "ready"
            | "failed";
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
    uploads: {
      confirmUpload: FunctionReference<
        "action",
        "internal",
        { filename?: string; height?: number; key: string; width?: number },
        any,
        Name
      >;
    };
  };
