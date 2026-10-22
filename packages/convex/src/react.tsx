"use client";

import React from "react";
import {
	buildMediaUrl,
	CaptionLocaleLabel,
	type DevulturKind,
	type DevulturMedia,
	type FailureReason,
	MediaStatus,
	type MediaStatusValue,
	mediaCaptionPath,
	mediaPath,
	mediaUrl,
	type ProcessingPhase,
	type Visibility,
	visibilityFromKey,
} from "@devultur/core";
import {
	type MediaUploadError,
	type MediaUploadState,
	UploadHttpError,
	type UploadProgress,
	uploadFileWithProgress,
} from "@devultur/react";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { DevulturCapabilityError } from "./capability-error";
import { fetchMedia, MediaFetchError, tokenUnavailableError } from "./media-fetch";
import { type MediaRenderOptions, type MediaSession, useMediaSession, type ViewerTokenAction } from "./media-session";
import { deriveUploadState, type UploadPhase } from "./media-upload-derive";
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
	AttachmentCard,
	type AttachmentCardProps,
	DocumentLink,
	type DocumentLinkProps,
} from "./document-renderers";
export { Image, type ImageProps } from "./image";
export { MediaFetchError, type MediaFetchErrorCode } from "./media-fetch";
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
export { type PdfPreviewConfig, PdfPreviewProvider } from "./pdf-context";
export type { PdfjsLoader, PdfjsModule } from "./pdf-render";
export { PdfThumbnail, type PdfThumbnailProps } from "./pdf-thumbnail";
export { Preview, type PreviewProps } from "./preview";
export { defaultPreviewLabels, type PreviewLabels } from "./preview-labels";
export type { PreviewKind } from "./preview-type";
export {
	type MediaLibraryState,
	type MediaLibraryStatus,
	type UseMediaLibraryOptions,
	useMediaLibrary,
} from "./use-media-library";
export type { MediaPickerUpload, MediaPickerUploads } from "./use-media-picker-uploads";
export type { TokenStatus, ViewerTokenArgs, ViewerTokenResult } from "./viewer-token";

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

interface UploadOptions {
	/** Visibility override for this resource. Omitted → inherits the router's default by type. */
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
interface UploadTarget {
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
interface DevulturContextValue extends MediaSession {
	uploadUrl: (file: File) => Promise<{ url: string; key: string }>;
	/** Uploads a file (reporting progress), records it in the component, and returns the reference ready to save. */
	upload: (file: File, options?: UploadOptions) => Promise<UploadedMedia>;
	/** Deletes a media by reference: video → full folder; image/file → the object. */
	deleteMedia: (media: DevulturMedia) => void;
}

interface ProgressContextValue {
	save: (videoId: string, position: number) => Promise<void>;
	load: (videoId: string) => Promise<{ lastPosition: number; completedAt: Date | null } | null>;
	markComplete: (videoId: string) => Promise<void>;
	reset: (videoId: string) => Promise<void>;
}

const DevulturContext = React.createContext<DevulturContextValue | null>(null);
const DevulturApiContext = React.createContext<DevulturApi | null>(null);
const ProgressContext = React.createContext<ProgressContextValue | null>(null);

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
	const session = useMediaSession({ issueViewerToken: issueViewerToken ?? api.issueViewerToken, tokenArgs, baseUrl });
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

	return <ProgressContext value={value}>{children}</ProgressContext>;
}

export function useDevultur(): DevulturContextValue {
	const context = React.use(DevulturContext);
	if (!context) throw new Error("useDevultur must be used within <DevulturProvider> or <DevulturViewerProvider>");
	return context;
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

interface DevulturViewerProviderProps {
	/** Media worker base (e.g. `https://media.your-domain.com`). */
	baseUrl: string;
	/** Your viewer token action. It receives `{ sessionSecret, ...tokenArgs }`, like `<DevulturProvider>`'s. */
	issueViewerToken: ViewerTokenAction;
	/** Extra arguments for `issueViewerToken`, compared by value (see `<DevulturProvider tokenArgs>`). */
	tokenArgs?: ViewerTokenArgs;
	children: React.ReactNode;
}

const VIEWER_ACTIONS: Pick<DevulturContextValue, "uploadUrl" | "upload" | "deleteMedia"> = {
	uploadUrl: () => Promise.reject(new DevulturCapabilityError("uploadUrl")),
	upload: () => Promise.reject(new DevulturCapabilityError("upload")),
	deleteMedia: () => {
		throw new DevulturCapabilityError("deleteMedia");
	},
};

/**
 * A provider for apps that only display media: it issues and renews the viewer token, so `<Image>`, `<Preview>`,
 * `<DownloadLink>`, `useMediaObjectUrl` and the video hooks work, and it needs no upload or delete actions. `upload`,
 * `uploadUrl` and `deleteMedia` throw a `DevulturCapabilityError`, as do the hooks that need the `api`
 * (`useMediaUpload`, `useDevulturApi`, `<MediaLibrary>`, `<MediaPicker>`).
 *
 * @example
 * <DevulturViewerProvider baseUrl={MEDIA_URL} issueViewerToken={api.admin.issueViewerToken} tokenArgs={{ workspaceId }}>
 *   <Preview media={document.file} />
 * </DevulturViewerProvider>
 */
export function DevulturViewerProvider({
	baseUrl,
	issueViewerToken,
	tokenArgs,
	children,
}: DevulturViewerProviderProps) {
	const session = useMediaSession({ issueViewerToken, tokenArgs, baseUrl });
	const devulturValue = React.useMemo(() => ({ ...session, ...VIEWER_ACTIONS }), [session]);
	return <DevulturContext value={devulturValue}>{children}</DevulturContext>;
}

export function useDevulturProgress(): ProgressContextValue {
	const context = React.use(ProgressContext);
	if (!context) throw new Error("useDevulturProgress requires progress API in DevulturProvider");
	return context;
}

/**
 * Ready-to-use delivery URL for a key, with the context's viewer token already injected. The consumer
 * never touches the token or the query — it only declares what it wants (download, resize, etc.).
 *
 * @example
 * <img src={useMediaUrl(key)} />
 * <a href={useMediaUrl(key, { download: true })} download>Download</a>
 * <img src={useMediaUrl(key, { width: 512, format: "webp" })} />
 */
export function useMediaUrl(key: string | null | undefined, options?: MediaRenderOptions): string | null {
	const { token, baseUrl } = useDevultur();
	return React.useMemo(() => {
		if (!key) return null;
		if (!baseUrl) throw new Error("useMediaUrl requires `baseUrl` on <DevulturProvider>");
		// Token-transparent via the visibility in the key's prefix: public doesn't attach a token.
		const isPublic = visibilityFromKey(key) === "public";
		return buildMediaUrl(baseUrl, key, { ...options, token: isPublic ? undefined : (token ?? undefined) });
	}, [key, baseUrl, token, options]);
}

// Records the upload in the component. Best-effort: the bytes are stored, and the component's scheduled check records
// an upload nobody confirmed, so a failure here never fails the upload.
async function confirmUploadBestEffort(
	confirmUpload: (args: Record<string, unknown>) => Promise<unknown>,
	key: string,
	file: File,
	hints: { width?: number; height?: number; pageCount?: number },
): Promise<void> {
	try {
		await confirmUpload({ key, filename: file.name, ...hints });
	} catch (error) {
		console.warn("Devultur: could not record the upload; it is recorded later", error);
	}
}

// Captures an image's intrinsic dimensions in the browser (for <img> with no CLS). No-op outside the
// browser or for non-images → empty object. Fails silently: dimensions are best-effort.
async function readImageDimensions(file: File): Promise<{ width?: number; height?: number }> {
	if (typeof createImageBitmap !== "function" || !file.type.startsWith("image/")) return {};
	try {
		const bitmap = await createImageBitmap(file);
		const dimensions = { width: bitmap.width, height: bitmap.height };
		bitmap.close();
		return dimensions;
	} catch {
		return {};
	}
}

export interface VideoProps {
	src: string;
	token: string | undefined;
	captions: { locale: string; label: string; src: string }[];
	/** Session secret → `<VideoPlayer>` sends it in `${SESSION_HEADER}` on hls.js/captions requests. */
	sessionSecret?: string;
}

/**
 * Token-transparent props for `<VideoPlayer>` from a video reference: builds the HLS playlist `src`,
 * the viewer `token` (only if private), and the `captions` for the requested locales.
 * The consumer just does `<VideoPlayer {...useVideoProps(lesson.video, { locales })} />`.
 */
export function useVideoProps(
	media: DevulturMedia | null | undefined,
	options?: { locales?: string[] },
): VideoProps | null {
	const { token, baseUrl, sessionSecret } = useDevultur();
	const locales = options?.locales;
	return React.useMemo(() => {
		if (media?.kind !== "video") return null;
		if (!baseUrl) throw new Error("useVideoProps requires `baseUrl` on <DevulturProvider>");
		const viewerToken = media.visibility === "private" ? (token ?? undefined) : undefined;
		const captions = (locales ?? []).flatMap((locale) => {
			const path = mediaCaptionPath(media, locale);
			if (!path) return [];
			const label = CaptionLocaleLabel[locale as keyof typeof CaptionLocaleLabel] ?? locale;
			return [{ locale, label, src: buildMediaUrl(baseUrl, path, { token: viewerToken }) }];
		});
		return {
			src: buildMediaUrl(baseUrl, mediaPath(media), { token: viewerToken }),
			token: viewerToken,
			captions,
			sessionSecret: media.visibility === "private" ? sessionSecret : undefined,
		};
	}, [media, baseUrl, token, locales, sessionSecret]);
}

// --- <DownloadLink> (declarative download, token-transparent, usable in .map) ---

interface DownloadLinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "download" | "media"> {
	media: DevulturMedia | null | undefined;
	/** Name it downloads as. Without this it uses the upload's original name. */
	filename?: string;
	/**
	 * A private download that failed: `token_unavailable` right away when the viewer token couldn't be issued
	 * (`useDevultur().retryToken()` tries again), `http_error` when the delivery refused it.
	 */
	onDownloadError?: (error: MediaFetchError) => void;
	children: React.ReactNode;
}

/**
 * `<a>` that downloads a media with its original name (token-transparent). The worker serves it with
 * `Content-Disposition: attachment`, so a click downloads the file instead of opening it in a tab.
 *
 * Private: an `<a download>` NAVIGATES, and a navigation can't send `${SESSION_HEADER}` → with session
 * binding the gate gives a 401. So, for private media, we intercept the click, blob-fetch with the header
 * (like private `<Image>`) and trigger the download from the object URL. Public keeps native navigation.
 */
export function DownloadLink({ media, filename, onDownloadError, children, ...anchorProps }: DownloadLinkProps) {
	const { url, token, tokenStatus, tokenError, baseUrl, sessionSecret, reissueToken } = useDevultur();

	const handleClick = React.useCallback(
		async (event: React.MouseEvent<HTMLAnchorElement>) => {
			// Public (or no media/baseUrl) → let the `<a>` navigate (tokenless, cacheable, no header).
			if (media?.visibility !== "private" || !baseUrl) return;
			event.preventDefault();
			if (tokenStatus === "error") {
				onDownloadError?.(tokenUnavailableError(tokenError));
				return;
			}
			// URL with an explicit token → on retry we use the fresh token (the context's `url()` would stay
			// stale inside the handler until the next render).
			const response = await fetchMedia({
				buildUrl: (viewerToken) => mediaUrl(baseUrl, media, { download: filename ?? true, token: viewerToken }),
				token,
				sessionSecret,
				reissueToken,
			});
			if (!response.ok) {
				const status = response.status;
				onDownloadError?.(new MediaFetchError("http_error", `Media fetch failed: ${status}`, status));
				return;
			}
			const objectUrl = URL.createObjectURL(await response.blob());
			const anchor = document.createElement("a");
			anchor.href = objectUrl;
			anchor.download = filename ?? media.filename ?? "download";
			anchor.click();
			URL.revokeObjectURL(objectUrl);
		},
		[media, baseUrl, token, tokenStatus, tokenError, filename, sessionSecret, reissueToken, onDownloadError],
	);

	if (!media) return null;
	return (
		<a href={url(media, { download: filename ?? true })} download {...anchorProps} onClick={handleClick}>
			{children}
		</a>
	);
}

// --- useDevulturMedia (reactive media status from component's table) ---

interface MediaStatusReturn {
	status: MediaStatusValue;
	/** Typed progress: `phase` is the pipeline step (no `as any`). */
	progress: { current: number; total: number; percent: number; phase?: ProcessingPhase } | null;
	error: string | null;
	/** Categorized failure reason (null if it didn't fail). */
	failureReason: FailureReason | null;
	/** Whether the failure is retriable (null if it didn't fail). */
	retriable: boolean | null;
	isQueued: boolean;
	isTranscoding: boolean;
	isCaptioning: boolean;
	isReady: boolean;
	isFailed: boolean;
	playlistUrl: string | null;
	thumbnailKey: string | null;
	captionLocales: string[];
	duration: number | null;
	isLoading: boolean;
}

export function useDevulturMedia(key: string | null | undefined): MediaStatusReturn {
	const apiCtx = React.use(DevulturApiContext);
	if (!apiCtx?.getMedia) {
		throw new Error("useDevulturMedia requires getMedia in DevulturProvider api");
	}

	const record = useQuery(apiCtx.getMedia, key ? { key } : "skip");

	if (!record) {
		return {
			status: MediaStatus.IDLE,
			progress: null,
			error: null,
			failureReason: null,
			retriable: null,
			isQueued: false,
			isTranscoding: false,
			isCaptioning: false,
			isReady: false,
			isFailed: false,
			playlistUrl: null,
			thumbnailKey: null,
			captionLocales: [],
			duration: null,
			isLoading: record === undefined,
		};
	}

	const status = (record.transcodeStatus as MediaStatusValue) ?? MediaStatus.IDLE;
	const isReady = status === MediaStatus.READY;
	const isFailed = status === MediaStatus.FAILED;

	const progress = record.transcodeProgress
		? {
				current: record.transcodeProgress.current as number,
				total: record.transcodeProgress.total as number,
				percent:
					(record.transcodeProgress.total as number) > 0
						? Math.round(
								((record.transcodeProgress.current as number) / (record.transcodeProgress.total as number)) * 100,
							)
						: 0,
				phase: record.transcodeProgress.phase as ProcessingPhase | undefined,
			}
		: null;

	return {
		status,
		progress,
		error: (record.transcodeError as string) ?? null,
		failureReason: isFailed ? ((record.failureReason as FailureReason) ?? "internal") : null,
		retriable: isFailed ? ((record.retriable as boolean) ?? true) : null,
		isQueued: status === MediaStatus.QUEUED,
		isTranscoding: status === MediaStatus.TRANSCODING,
		isCaptioning: status === MediaStatus.CAPTIONING,
		isReady,
		isFailed,
		playlistUrl: (record.playlistUrl as string) ?? null,
		thumbnailKey: (record.thumbnailKey as string) ?? null,
		captionLocales: (record.captionLocales as string[]) ?? [],
		duration: (record.duration as number) ?? null,
		isLoading: false,
	};
}

// --- useVideoState (discriminated union — exhaustive, typed, no boolean bag) ---

export interface CaptionTrack {
	locale: string;
	label: string;
	src: string;
}

/**
 * A video's pipeline state as a **discriminated union** on `phase`: the render is an exhaustive
 * `switch` (no boolean ordering or `as any`), and adding a new phase is a compile error until it's
 * handled. `processing` carries typed `step`/`percent`; `ready` carries the ref + props ready for
 * `<VideoPlayer>` (token-transparent); `failed` carries a categorized `reason` + `retriable`.
 */
export type VideoState =
	| { phase: "idle" }
	| { phase: "queued" }
	| { phase: "processing"; step: ProcessingPhase; percent: number }
	| {
			phase: "ready";
			media: DevulturMedia;
			playlist: string;
			duration: number;
			captions: CaptionTrack[];
			playerProps: VideoProps;
	  }
	| { phase: "failed"; reason: FailureReason; message: string; retriable: boolean };

export function useVideoState(media: DevulturMedia | null | undefined, options?: { locales?: string[] }): VideoState {
	const { token, baseUrl, sessionSecret } = useDevultur();
	const status = useDevulturMedia(media?.kind === "video" ? media.id : null);
	const locales = options?.locales;

	return React.useMemo((): VideoState => {
		if (media?.kind !== "video") return { phase: "idle" };

		if (status.isFailed) {
			return {
				phase: "failed",
				reason: status.failureReason ?? "internal",
				message: status.error ?? "Video processing failed",
				retriable: status.retriable ?? true,
			};
		}

		if (status.isReady) {
			if (!baseUrl) throw new Error("useVideoState requires `baseUrl` on <DevulturProvider>");
			const viewerToken = media.visibility === "private" ? (token ?? undefined) : undefined;
			const playlist = buildMediaUrl(baseUrl, mediaPath(media), { token: viewerToken });
			const captions = (locales ?? status.captionLocales).flatMap((locale) => {
				const path = mediaCaptionPath(media, locale);
				if (!path) return [];
				const label = CaptionLocaleLabel[locale as keyof typeof CaptionLocaleLabel] ?? locale;
				return [{ locale, label, src: buildMediaUrl(baseUrl, path, { token: viewerToken }) }];
			});
			return {
				phase: "ready",
				media,
				playlist,
				duration: status.duration ?? 0,
				captions,
				playerProps: {
					src: playlist,
					token: viewerToken,
					captions,
					sessionSecret: media.visibility === "private" ? sessionSecret : undefined,
				},
			};
		}

		if (status.isQueued) return { phase: "queued" };

		if (status.isTranscoding || status.isCaptioning) {
			const step: ProcessingPhase = status.progress?.phase ?? (status.isCaptioning ? "captioning" : "encoding");
			return { phase: "processing", step, percent: status.progress?.percent ?? 0 };
		}

		return { phase: "idle" };
	}, [media, status, baseUrl, token, locales, sessionSecret]);
}

// --- useMediaUpload (unified lifecycle: upload → transcode → ready, one state machine) ---

export interface UseMediaUploadOptions {
	/** Resource visibility. Omitted → config default → private (secure-by-default). */
	visibility?: Visibility;
	/** Fires ONCE, at the persistence point (PUT done + transcode requested). */
	onComplete?: (media: DevulturMedia) => void;
	onError?: (error: MediaUploadError) => void;
	/** Deletes this old video/asset after a successful PUT (best-effort). */
	replaces?: DevulturMedia | null;
	/** Auto-request the transcode for videos. Default `true`; `false` = upload the raw file unprocessed. */
	process?: boolean;
	/** Caption locales to request when transcoding. */
	locales?: string[];
}

export interface UseMediaUploadReturn {
	/** Triggers the upload; resolves with the `DevulturMedia` at the persistence point, or `null` if cancelled/failed. */
	upload: (file: File) => Promise<DevulturMedia | null>;
	/** The reactive state machine for the full cycle. */
	state: MediaUploadState;
	/** Aborts the in-progress PUT (`uploading` phase). */
	cancel: () => void;
	/** Returns to `idle` and clears everything. */
	reset: () => void;
}

/**
 * Unified upload primitive: hides the seam between the (imperative) upload and the (reactive)
 * transcode behind ONE state machine. The consumer calls `upload(file)`, persists the ref in
 * `onComplete`, and renders a `switch` over `state.phase`. Video triggers the transcode on its own;
 * image/file go straight to `ready`. Requires `createUploadUrl` + `getMedia` in the provider (and
 * `processVideo` for video).
 */
export function useMediaUpload(options?: UseMediaUploadOptions): UseMediaUploadReturn {
	const { visibility, onComplete, onError, replaces, process, locales } = options ?? {};

	const api = useDevulturApi();
	const createUploadUrlAction = useAction(api.createUploadUrl);
	const deleteMediaAction = useAction(api.deleteMedia);
	// Fallback refs to respect the rules of hooks; only invoked if `api.confirmUpload` / `api.processVideo` exist.
	const confirmUploadAction = useAction(api.confirmUpload ?? api.createUploadUrl);
	const processVideoAction = useAction(api.processVideo ?? api.createUploadUrl);

	const [phase, setPhase] = React.useState<UploadPhase>("idle");
	const [percent, setPercent] = React.useState(0);
	const [currentFile, setCurrentFile] = React.useState<File | null>(null);
	const [media, setMedia] = React.useState<DevulturMedia | null>(null);
	const [uploadFailure, setUploadFailure] = React.useState<MediaUploadError | null>(null);
	const [processRequested, setProcessRequested] = React.useState(false);

	const abortRef = React.useRef<AbortController | null>(null);
	const lastFileRef = React.useRef<File | null>(null);
	const lastKeyRef = React.useRef<string | null>(null);

	const videoState = useVideoState(media, { locales });

	const triggerProcess = React.useCallback(
		(key: string) => {
			if (!api.processVideo) {
				throw new Error("useMediaUpload: processing a video requires `processVideo` in the <DevulturProvider> api");
			}
			lastKeyRef.current = key;
			setProcessRequested(true);
			processVideoAction({ key }).catch((err: unknown) => {
				// The real pipeline failure arrives via the component's state (transcode.failed → state.failed);
				// here we only leave a trace if the request itself couldn't even be made.
				console.error("useMediaUpload: could not request the transcode", err);
			});
		},
		[api.processVideo, processVideoAction],
	);

	const runUpload = React.useCallback(
		async (file: File): Promise<DevulturMedia | null> => {
			const controller = new AbortController();
			abortRef.current = controller;
			lastFileRef.current = file;
			setUploadFailure(null);
			setMedia(null);
			setProcessRequested(false);
			setCurrentFile(file);
			setPercent(0);
			setPhase("uploading");

			const fail = (reason: MediaUploadError["reason"], message: string): null => {
				const failure: MediaUploadError = { stage: "upload", reason, retriable: true, message };
				setUploadFailure(failure);
				setPhase("upload-failed");
				onError?.(failure);
				return null;
			};

			let result: UploadTarget;
			try {
				result = (await createUploadUrlAction({
					filename: file.name,
					contentType: file.type,
					visibility,
				})) as typeof result;
			} catch (err) {
				return fail("rejected", err instanceof Error ? err.message : "Could not start the upload");
			}

			const dimensions = await readImageDimensions(file);

			try {
				await uploadFileWithProgress(result.url, file, { onProgress: setPercent, signal: controller.signal });
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") {
					setPhase("idle");
					setCurrentFile(null);
					setPercent(0);
					return null;
				}
				const rejected = err instanceof UploadHttpError && (err.status === 413 || err.status === 415);
				return fail(rejected ? "rejected" : "network", err instanceof Error ? err.message : "The upload failed");
			}

			// Before the transcode request: both write the media record, and this one carries the upload's fields.
			if (api.confirmUpload) await confirmUploadBestEffort(confirmUploadAction, result.key, file, dimensions);

			const uploaded: DevulturMedia = {
				id: result.id,
				kind: result.kind,
				visibility: result.visibility,
				filename: file.name,
				key: result.key,
				...dimensions,
			};
			setMedia(uploaded);
			setPhase("uploaded");

			if (replaces) deleteMediaAction({ key: mediaPath(replaces) }).catch(() => {});
			onComplete?.(uploaded);

			if ((process ?? true) && uploaded.kind === "video") triggerProcess(result.key);

			return uploaded;
		},
		[
			createUploadUrlAction,
			confirmUploadAction,
			api.confirmUpload,
			deleteMediaAction,
			triggerProcess,
			visibility,
			replaces,
			process,
			onComplete,
			onError,
		],
	);

	const cancel = React.useCallback(() => {
		abortRef.current?.abort();
	}, []);

	const reset = React.useCallback(() => {
		abortRef.current?.abort();
		setPhase("idle");
		setPercent(0);
		setCurrentFile(null);
		setMedia(null);
		setUploadFailure(null);
		setProcessRequested(false);
	}, []);

	const retry = React.useCallback(() => {
		if (phase === "upload-failed" && lastFileRef.current) {
			runUpload(lastFileRef.current);
			return;
		}
		if (lastKeyRef.current) triggerProcess(lastKeyRef.current);
	}, [phase, runUpload, triggerProcess]);

	React.useEffect(() => () => abortRef.current?.abort(), []);

	const state = React.useMemo(
		(): MediaUploadState =>
			deriveUploadState(
				{ phase, percent, file: currentFile, failure: uploadFailure, media, processRequested },
				videoState,
				retry,
			),
		[phase, percent, currentFile, uploadFailure, media, processRequested, videoState, retry],
	);

	const upload = React.useCallback((file: File) => runUpload(file), [runUpload]);

	return { upload, state, cancel, reset };
}
