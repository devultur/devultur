"use client";

import type React from "react";
import { type DevulturMedia, mediaPath } from "@devultur/core";
import { MediaFetchError, networkError } from "./media-fetch";
import { useMediaObjectUrl } from "./media-object-url";
import { useMediaResource } from "./media-resource";
import { usePreviewLabels } from "./pdf-context";
import { PdfPreview, type RenderFallback, VISUALLY_HIDDEN } from "./pdf-preview";
import type { PreviewLabels } from "./preview-labels";
import { expectedContentType, type PreviewKind, previewKindOf } from "./preview-type";
import { DownloadLink, useDevultur } from "./react";
import { VideoPreview } from "./video-preview";

/** Default cap for text previews: a `<pre>` with megabytes of text isn't a preview. */
const DEFAULT_MAX_TEXT_BYTES = 1024 * 1024;
/** Default cap for images, PDFs and audio held in memory as a blob. */
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export interface PreviewProps {
	/** Typed reference. `null`/`undefined` → renders nothing. */
	media: DevulturMedia | null | undefined;
	/** The type you know the media has (e.g. stored with it). Default: inferred from `media.filename`'s extension. */
	contentType?: string;
	/** Size cap for images, PDFs and audio; larger files render `fallback`. Default 50 MiB. */
	maxBytes?: number;
	/** Size cap for text previews. Default 1 MiB. */
	maxTextBytes?: number;
	/**
	 * Shown for types that don't preview inline, when the fetch or render fails, and after the `maxPages` note.
	 * Default: a `<DownloadLink>`. As a function it receives why, always a `MediaFetchError` (never `null`: it's only
	 * called with a cause): `http_error` when the delivery refused the fetch (`status`) or never answered (a network
	 * failure, no `status`), `too_large`, `type_mismatch`, `token_unavailable` (no viewer token, nothing fetched),
	 * `session_mismatch` (a video's session was refused), `unsupported_type` (the type doesn't preview inline, nothing
	 * fetched), `render_failed` (pdf.js can't open the PDF, or the video can't be played) or `page_cap` (the link after
	 * the `maxPages` note, with `details: { shown, total }`).
	 */
	fallback?: React.ReactNode | ((error: MediaFetchError) => React.ReactNode);
	/** Shown while a file loads. Default: `labels.loading`, visually hidden, in a `role="status"`. `null` → nothing. */
	loading?: React.ReactNode;
	/** Accessible name of the preview (`alt`, `title`, `aria-label`). Default: the filename (text: none). */
	title?: string;
	className?: string;
	/**
	 * PDF pages rendered with pdf.js; past it, a "first N of M pages" note and `fallback`. Default 500 (a tiny file
	 * can declare millions of pages).
	 */
	maxPages?: number;
	/** URL of pdf.js's worker for this preview; overrides `PdfPreviewProvider`'s `workerSrc`. */
	pdfWorkerSrc?: string;
	/** Overrides any string shown or announced; wins over `PdfPreviewProvider`'s `labels`. English by default. */
	labels?: Partial<PreviewLabels>;
	/**
	 * A video's playback metrics (`<VideoPlayer metrics>`): anonymous, no cookies, sent to the media host. On by
	 * default; `false` turns them off.
	 */
	metrics?: boolean;
}

/**
 * Renders a media inline by its content type: images in an `<img>`, PDFs on `<canvas>` pages with pdf.js under a
 * `PdfPreviewProvider` (otherwise in an `<iframe>`), audio in an `<audio>`,
 * plain text, CSV and JSON in a `<pre>`, and video in the streaming `<VideoPlayer>`. Everything else (HTML, SVG,
 * XML, unknown types) and every refused fetch render `fallback`. Private media is token-transparent.
 *
 * @example
 * <Preview media={document.file} maxBytes={20_000_000} className="h-[80vh] w-full" />
 */
export function Preview({ media, contentType, fallback, loading, labels, metrics, ...viewProps }: PreviewProps) {
	const text = usePreviewLabels(labels);
	if (!media) return null;

	const renderFallback: RenderFallback = (error) => {
		// The views hand over `MediaFetchError`s; anything else is a fetch that never got an answer.
		const fetchError = error instanceof MediaFetchError ? error : networkError(error);
		if (typeof fallback === "function") return fallback(fetchError);
		if (fallback !== undefined) return fallback;
		return <DefaultFallback media={media} error={fetchError} labels={text} />;
	};
	const loadingNode = loading === undefined ? <LoadingStatus text={text.loading} /> : loading;
	if (media.kind === "video") {
		return (
			<VideoPreview
				key={mediaPath(media)}
				media={media}
				renderFallback={renderFallback}
				loading={loadingNode}
				metrics={metrics}
				className={viewProps.className}
			/>
		);
	}
	const expectedType = expectedContentType(media, contentType);
	const kind = previewKindOf(expectedType);
	if (!expectedType || !kind) return <>{renderFallback(unsupportedType(expectedType))}</>;

	const props = { ...viewProps, media, expectedType, renderFallback, loading: loadingNode, labels: text };
	if (kind === "text") return <TextPreview {...props} />;
	if (kind === "pdf") return <PdfPreview {...props} maxBytes={props.maxBytes ?? DEFAULT_MAX_BYTES} />;
	return <BinaryPreview {...props} kind={kind} />;
}

const unsupportedType = (contentType: string | null | undefined) =>
	new MediaFetchError("unsupported_type", `Can't preview ${contentType ?? "an unknown type"} inline`);

interface DefaultFallbackProps {
	media: DevulturMedia;
	error: MediaFetchError;
	labels: PreviewLabels;
}

function DefaultFallback({ media, error, labels }: DefaultFallbackProps) {
	return (
		<DownloadLink media={media} title={labels.error(error.code)}>
			{media.filename ?? labels.download}
		</DownloadLink>
	);
}

function LoadingStatus({ text }: { text: string }) {
	return (
		<span role="status" style={VISUALLY_HIDDEN}>
			{text}
		</span>
	);
}

interface ViewProps extends Omit<PreviewProps, "contentType" | "fallback" | "labels"> {
	media: DevulturMedia;
	expectedType: string;
	renderFallback: RenderFallback;
	loading: React.ReactNode;
	labels: PreviewLabels;
}

function BinaryPreview({
	media,
	kind,
	expectedType,
	maxBytes = DEFAULT_MAX_BYTES,
	renderFallback,
	loading,
	labels,
	title,
	className,
}: ViewProps & { kind: Exclude<PreviewKind, "text" | "pdf"> }) {
	const { url } = useDevultur();
	// An `<img>` never runs script, so a public image keeps its cacheable delivery URL. Everything else, public too, is
	// fetched: `contentType` makes the hook refuse a response whose type disagrees and create the blob with
	// `expectedType`, so nothing is framed before its type is verified.
	const isPublicImage = kind === "image" && media.visibility === "public";
	const verified = useMediaObjectUrl(media, { enabled: !isPublicImage, contentType: expectedType, maxBytes });
	const objectUrl = isPublicImage ? url(media) : verified.objectUrl;
	if (verified.error) return <>{renderFallback(verified.error)}</>;
	if (!objectUrl) return <>{loading}</>;
	const label = title ?? media.filename ?? labels.untitledMedia;

	if (kind === "image") {
		return <img src={objectUrl} alt={label} width={media.width} height={media.height} className={className} />;
	}
	// biome-ignore lint/a11y/useMediaCaption: an uploaded audio file has no caption track to offer.
	return <audio src={objectUrl} controls aria-label={label} className={className} />;
}

const decodeText = (bytes: Uint8Array<ArrayBuffer>) => new TextDecoder().decode(bytes);

// Text is decoded and rendered by React (escaped): no object URL, so no document is ever created from it.
function TextPreview({
	media,
	expectedType,
	maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
	renderFallback,
	loading,
	title,
	className,
}: ViewProps) {
	const { value: text, error } = useMediaResource(media, {
		isEnabled: true,
		maxBytes: maxTextBytes,
		contentType: expectedType,
		decode: decodeText,
	});
	if (error) return <>{renderFallback(error)}</>;
	if (text === null) return <>{loading}</>;
	return (
		<pre title={title} className={className}>
			{text}
		</pre>
	);
}
