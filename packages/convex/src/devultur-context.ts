"use client";

// The contexts both providers fill, and the hooks that read them.
import React from "react";
import type { DevulturKind, DevulturMedia, Visibility } from "@devultur/core";
import type { UploadProgress } from "@devultur/react";
import type { FunctionReference } from "convex/server";
import { DevulturCapabilityError } from "./capability-error";
import type { MediaSession } from "./media-session";

type AnyAction = FunctionReference<"action">;
type AnyMutation = FunctionReference<"mutation">;
type AnyQuery = FunctionReference<"query">;

export interface DevulturApi {
	issueViewerToken: AnyAction;
	createUploadUrl: AnyAction;
	/** Records an upload in the component after its PUT, so it shows in `listMedia`. Optional (uploads still work). */
	confirmUpload?: AnyAction;
	deleteMedia: AnyAction;
	/** Deletes the full folder of a video (raw/hls/thumbnails/captions). Required to delete videos. */
	deleteVideo?: AnyAction;
	/** Requests the transcode of an uploaded video. Required by `useMediaUpload` for auto-process. */
	processVideo?: AnyAction;
	getMedia?: AnyQuery;
	/** The library, newest first. Required by `useMediaLibrary` and `<MediaLibrary>`. */
	listMediaPage?: AnyQuery;
	/** The library matching a search. Required by `useMediaLibrary` and `<MediaLibrary>` to search. */
	searchMedia?: AnyQuery;
	saveProgress?: AnyMutation;
	loadProgress?: AnyQuery;
	markComplete?: AnyMutation;
	resetProgress?: AnyMutation;
}

export interface UploadOptions {
	/**
	 * Visibility override for this resource. Omitted → `config.upload.visibility` on your server, else the Worker's
	 * default by type. Your guard can still rewrite it.
	 */
	visibility?: Visibility;
	/** Progress of the PUT: bytes sent, total bytes and their fraction (0 to 1). */
	onProgress?: (progress: UploadProgress) => void;
	/** Aborts the PUT → `upload()` rejects with an `AbortError`. */
	signal?: AbortSignal;
	/** A PDF's page count to record with it, a hint (`countPdfPages` from `@devultur/convex/pdfjs` counts it). */
	pageCount?: number;
}

/**
 * The reference `upload()` resolves to: a `DevulturMedia` whose `key` is always set (the uploaded object's key; a
 * video's raw file, what `processVideo` takes). It stores as-is in a `dv.media()` field.
 */
export type UploadedMedia = DevulturMedia & { readonly key: string };

/** What `createUploadUrl` returns. */
export interface UploadTarget {
	url: string;
	key: string;
	id: string;
	kind: DevulturKind;
	visibility: Visibility;
}

/**
 * What `useDevultur()` returns. Under a `<DevulturViewerProvider>`, `uploadUrl`, `upload` and `deleteMedia` throw a
 * `DevulturCapabilityError` (`capability_unavailable`).
 */
export interface DevulturContextValue extends MediaSession {
	uploadUrl: (file: File) => Promise<{ url: string; key: string }>;
	/** Uploads a file (reporting progress), records it in the component, and returns the reference ready to save. */
	upload: (file: File, options?: UploadOptions) => Promise<UploadedMedia>;
	/** Deletes a media by reference: video → full folder; image/file → the object. */
	deleteMedia: (media: DevulturMedia) => void;
}

export const DevulturContext = /* @__PURE__ */ React.createContext<DevulturContextValue | null>(null);
export const DevulturApiContext = /* @__PURE__ */ React.createContext<DevulturApi | null>(null);

export function useDevultur(): DevulturContextValue {
	const context = React.use(DevulturContext);
	if (!context) throw new Error("useDevultur must be used within <DevulturProvider> or <DevulturViewerProvider>");
	return context;
}

/**
 * `useDevultur()` for components that also render outside a provider: the same value under `<DevulturProvider>` or
 * `<DevulturViewerProvider>`, and `null` outside both instead of throwing.
 */
export function useDevulturOptional(): DevulturContextValue | null {
	return React.use(DevulturContext);
}

/**
 * Whether the media hooks can build delivery URLs here: `true` under `<DevulturProvider>` or `<DevulturViewerProvider>`
 * with a non-empty `baseUrl`; `false` outside both, or under a `<DevulturProvider>` without one, where `useMediaUrl`,
 * `useVideoProps` and `url()` throw. That's all a public media needs. A private media also needs the viewer token,
 * which the provider may not have yet (lazy issuance) or can't issue (no `issueViewerToken`): `tokenStatus` from
 * `useDevultur()` tells, and the components handle it themselves.
 */
export function useCanDeliver(): boolean {
	return Boolean(React.use(DevulturContext)?.baseUrl);
}

/**
 * The `api` passed to `<DevulturProvider>`: your app's exported Devultur functions. Under a `<DevulturViewerProvider>`
 * it throws a `DevulturCapabilityError`.
 */
export function useDevulturApi(): DevulturApi {
	const api = React.use(DevulturApiContext);
	if (api) return api;
	if (React.use(DevulturContext)) throw new DevulturCapabilityError("api");
	throw new Error("useDevulturApi must be used within <DevulturProvider>");
}
