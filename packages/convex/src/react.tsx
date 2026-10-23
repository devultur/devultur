"use client";

import React from "react";
import { type DevulturMedia, mediaPath } from "@devultur/core";
import { uploadFileWithProgress } from "@devultur/react";
import { useAction, useConvex, useMutation } from "convex/react";
import type { FunctionReference } from "convex/server";
import {
	type DevulturApi,
	DevulturApiContext,
	DevulturContext,
	type UploadedMedia,
	type UploadOptions,
	type UploadTarget,
} from "./devultur-context";
import { useMediaSession, type ViewerTokenAction } from "./media-session";
import { DevulturProgressContext } from "./progress-context";
import { confirmUploadBestEffort, readImageDimensions } from "./upload-hints";
import type { ViewerTokenArgs } from "./viewer-token";

export type { MediaUploadError, MediaUploadState, UploadProgress } from "@devultur/react";
export {
	type AttachmentKind,
	type AttachmentLabels,
	defaultAttachmentLabels,
	formatDuration,
	formatFileSize,
} from "./attachment-labels";
export { type DevulturCapability, DevulturCapabilityError } from "./capability-error";
export type { CropUploadLabels, CropUploadProps, CropUploadRenderProps } from "./crop-upload";
export { CropUpload } from "./crop-upload";
export {
	type DevulturApi,
	DevulturApiContext,
	DevulturContext,
	type DevulturContextValue,
	type UploadedMedia,
	type UploadOptions,
	useCanDeliver,
	useDevultur,
	useDevulturApi,
	useDevulturOptional,
} from "./devultur-context";
export {
	AttachmentCard,
	type AttachmentCardProps,
	DocumentLink,
	type DocumentLinkProps,
} from "./document-renderers";
export { DownloadLink, type DownloadLinkProps } from "./download-link";
export { Image, type ImageProps } from "./image";
export { MediaFetchError, type MediaFetchErrorCode } from "./media-fetch";
export {
	type CaptionTrack,
	type MediaStatusReturn,
	useDevulturMedia,
	useVideoState,
	type VideoState,
} from "./media-hooks";
export { MediaLibrary, type MediaLibraryPart, type MediaLibraryProps } from "./media-library";
export type { MediaLibraryItemState } from "./media-library-item";
export { defaultMediaLibraryLabels, type MediaLibraryLabels } from "./media-library-labels";
export { type MediaObjectUrl, type UseMediaObjectUrlOptions, useMediaObjectUrl } from "./media-object-url";
export { MediaPicker, type MediaPickerProps } from "./media-picker";
export { matchesAccept } from "./media-picker-accept";
export { type MediaPickerState, useMediaPicker } from "./media-picker-context";
export { defaultMediaPickerLabels, type MediaPickerLabels } from "./media-picker-labels";
export type { MediaPickerLibraryProps } from "./media-picker-library";
export type { MediaPickerSelectionProps } from "./media-picker-selection";
export type { MediaPickerUploadProps } from "./media-picker-upload";
export { useMediaUrl, useVideoProps, type VideoProps } from "./media-url-hooks";
export { type PdfPreviewConfig, PdfPreviewProvider } from "./pdf-context";
export type { PdfjsLoader, PdfjsModule } from "./pdf-render";
export { PdfThumbnail, type PdfThumbnailProps } from "./pdf-thumbnail";
export { Preview, type PreviewProps } from "./preview";
export { defaultPreviewLabels, type PreviewLabels } from "./preview-labels";
export type { PreviewKind } from "./preview-type";
export {
	DevulturProgressContext,
	type DevulturProgressContextValue,
	useDevulturProgress,
} from "./progress-context";
export {
	type MediaLibraryState,
	type MediaLibraryStatus,
	type UseMediaLibraryOptions,
	useMediaLibrary,
} from "./use-media-library";
export type { MediaPickerUpload, MediaPickerUploads } from "./use-media-picker-uploads";
export { type UseMediaUploadOptions, type UseMediaUploadReturn, useMediaUpload } from "./use-media-upload";
export { DevulturViewerProvider, type DevulturViewerProviderProps } from "./viewer-provider";
export type { TokenStatus, ViewerTokenArgs, ViewerTokenResult } from "./viewer-token";

type AnyMutation = FunctionReference<"mutation">;
type AnyQuery = FunctionReference<"query">;

interface DevulturProviderProps {
	api: DevulturApi;
	/** Media worker base (e.g. `https://media.your-domain.com`). Required for `useMediaUrl`. */
	baseUrl?: string;
	/**
	 * Extra arguments sent with `sessionSecret` on every viewer token issuance (first, renewal and re-issue), for
	 * example `{ workspaceId }`. Compared by value: when they change, the current token is dropped and a new one is
	 * issued. The component's own `issueViewerToken` accepts only `sessionSecret`, so pass your own action in
	 * `issueViewerToken` that takes these arguments.
	 */
	tokenArgs?: ViewerTokenArgs;
	/**
	 * Your own viewer token action, used instead of `api.issueViewerToken`. It receives `{ sessionSecret, ...tokenArgs }`
	 * and returns what the component's `issueViewerToken` returns.
	 */
	issueViewerToken?: ViewerTokenAction;
	children: React.ReactNode;
}

export function DevulturProvider({ api, baseUrl, tokenArgs, issueViewerToken, children }: DevulturProviderProps) {
	const issueViewerTokenAction = useAction(issueViewerToken ?? api.issueViewerToken);
	const session = useMediaSession({ issueViewerToken: issueViewerTokenAction, tokenArgs, baseUrl });
	const createUploadUrlAction = useAction(api.createUploadUrl);
	const deleteMediaAction = useAction(api.deleteMedia);
	// Fallback ref to respect the rules of hooks; only invoked if `api.confirmUpload` exists.
	const confirmUploadAction = useAction(api.confirmUpload ?? api.createUploadUrl);
	// `useAction` can't be conditional (rules of hooks); if there's no `deleteVideo`, it falls back to
	// `deleteMedia` as a valid reference — but it's only invoked when `api.deleteVideo` exists (see `deleteMedia`).
	const deleteVideoAction = useAction(api.deleteVideo ?? api.deleteMedia);

	const uploadUrl = React.useCallback(
		async (file: File) => {
			const result = await createUploadUrlAction({ filename: file.name, contentType: file.type });
			return { url: result.url as string, key: result.key as string };
		},
		[createUploadUrlAction],
	);

	const upload = React.useCallback(
		async (file: File, options?: UploadOptions): Promise<UploadedMedia> => {
			const dimensions = await readImageDimensions(file);
			// Cancelled while the file was read (or a PDF's pages counted): no upload URL for an upload nobody wants.
			options?.signal?.throwIfAborted();
			const target = (await createUploadUrlAction({
				filename: file.name,
				contentType: file.type,
				visibility: options?.visibility,
			})) as UploadTarget;
			// XHR (fetch reports no upload progress); large files against the Worker go in parts.
			await uploadFileWithProgress(target.url, file, { onBytes: options?.onProgress, signal: options?.signal });
			if (api.confirmUpload) {
				const pageCount = options?.pageCount;
				const hints = { ...dimensions, ...(pageCount !== undefined ? { pageCount } : {}) };
				await confirmUploadBestEffort(confirmUploadAction, target.key, file, hints);
			}

			return {
				id: target.id,
				kind: target.kind,
				visibility: target.visibility,
				filename: file.name,
				key: target.key,
				...dimensions,
			};
		},
		[createUploadUrlAction, confirmUploadAction, api.confirmUpload],
	);

	const deleteMedia = React.useCallback(
		(media: DevulturMedia) => {
			// Video → deletes the whole folder (raw/hls/thumbnails/captions) + cleans up the component's records.
			// image/file → deletes the single object at its path. Without `deleteVideo` in the api, falls back to key-based delete.
			if (media.kind === "video" && api.deleteVideo) {
				deleteVideoAction({ videoId: media.id, visibility: media.visibility }).catch(console.error);
				return;
			}
			deleteMediaAction({ key: mediaPath(media) }).catch(console.error);
		},
		[deleteMediaAction, deleteVideoAction, api.deleteVideo],
	);

	const devulturValue = React.useMemo(
		() => ({ ...session, uploadUrl, upload, deleteMedia }),
		[session, uploadUrl, upload, deleteMedia],
	);

	let content = (
		<DevulturApiContext value={api}>
			<DevulturContext value={devulturValue}>{children}</DevulturContext>
		</DevulturApiContext>
	);

	if (api.saveProgress && api.loadProgress && api.markComplete && api.resetProgress) {
		content = (
			<ProgressBridge
				save={api.saveProgress}
				load={api.loadProgress}
				markComplete={api.markComplete}
				reset={api.resetProgress}
			>
				{content}
			</ProgressBridge>
		);
	}

	return content;
}

function ProgressBridge({
	save,
	load,
	markComplete,
	reset,
	children,
}: {
	save: AnyMutation;
	load: AnyQuery;
	markComplete: AnyMutation;
	reset: AnyMutation;
	children: React.ReactNode;
}) {
	const convex = useConvex();
	const saveMutation = useMutation(save);
	const markCompleteMutation = useMutation(markComplete);
	const resetMutation = useMutation(reset);

	const onSave = React.useCallback(
		async (videoId: string, position: number) => {
			await saveMutation({ videoId, position });
		},
		[saveMutation],
	);

	const onLoad = React.useCallback(
		async (videoId: string) => {
			const result = await convex.query(load, { videoId });
			if (!result) return null;
			return {
				lastPosition: result.lastPosition as number,
				completedAt: result.completedAt ? new Date(result.completedAt as number) : null,
			};
		},
		[convex, load],
	);

	const onMarkComplete = React.useCallback(
		async (videoId: string) => {
			await markCompleteMutation({ videoId });
		},
		[markCompleteMutation],
	);

	const onReset = React.useCallback(
		async (videoId: string) => {
			await resetMutation({ videoId });
		},
		[resetMutation],
	);

	const value = React.useMemo(
		() => ({ save: onSave, load: onLoad, markComplete: onMarkComplete, reset: onReset }),
		[onSave, onLoad, onMarkComplete, onReset],
	);

	return <DevulturProgressContext value={value}>{children}</DevulturProgressContext>;
}
