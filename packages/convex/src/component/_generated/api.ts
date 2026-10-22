/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as http from "../http.js";
import type * as library from "../library.js";
import type * as lock from "../lock.js";
import type * as lockValidators from "../lockValidators.js";
import type * as mediaClient from "../mediaClient.js";
import type * as mediaMeta from "../mediaMeta.js";
import type * as metadata from "../metadata.js";
import type * as public_ from "../public.js";
import type * as uploadKeys from "../uploadKeys.js";
import type * as uploads from "../uploads.js";
import type * as workerErrors from "../workerErrors.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  http: typeof http;
  library: typeof library;
  lock: typeof lock;
  lockValidators: typeof lockValidators;
  mediaClient: typeof mediaClient;
  mediaMeta: typeof mediaMeta;
  metadata: typeof metadata;
  public: typeof public_;
  uploadKeys: typeof uploadKeys;
  uploads: typeof uploads;
  workerErrors: typeof workerErrors;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {};
