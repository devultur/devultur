"use client";

import type React from "react";
import type { DevulturMedia } from "@devultur/core";
import { VideoPlayer } from "@devultur/react";
import { useMediaObjectUrl } from "./media-object-url";
import { useMediaResource } from "./media-resource";
import { PdfPreview } from "./pdf-preview";
import { expectedContentType, type PreviewKind, previewKindOf } from "./preview-type";
import { DownloadLink, useDevultur, useVideoProps } from "./react";

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
	/** Shown for types that don't preview inline and when the fetch fails. Default: a `<DownloadLink>`. */
	fallback?: React.ReactNode;
	/** Shown while a private file is loading. Default: nothing. */
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
export function Preview({ media, contentType, fallback, ...viewProps }: PreviewProps) {
	if (!media) return null;
	const fallbackNode =
		fallback === undefined ? <DownloadLink media={media}>{media.filename ?? "Download"}</DownloadLink> : fallback;
	if (media.kind === "video") return <VideoPreview media={media} className={viewProps.className} />;

	const expectedType = expectedContentType(media, contentType);
	const kind = previewKindOf(expectedType);
	if (!expectedType || !kind) return <>{fallbackNode}</>;

	const props = { ...viewProps, media, expectedType, fallback: fallbackNode };
	if (kind === "text") return <TextPreview {...props} />;
	if (kind === "pdf") {
		const { maxBytes = DEFAULT_MAX_BYTES, loading = null } = props;
		return <PdfPreview {...props} maxBytes={maxBytes} loading={loading} />;
	}
	return <BinaryPreview {...props} kind={kind} />;
}

interface ViewProps extends Omit<PreviewProps, "contentType" | "fallback"> {
	media: DevulturMedia;
	expectedType: string;
	fallback: React.ReactNode;
}

// Video never goes through a blob: the player streams HLS and sends the session header itself.
function VideoPreview({ media, className }: { media: DevulturMedia; className?: string }) {
	const videoProps = useVideoProps(media);
	if (!videoProps) return null;
	return <VideoPlayer {...videoProps} className={className} />;
}

function BinaryPreview({
	media,
	kind,
	expectedType,
	maxBytes = DEFAULT_MAX_BYTES,
	fallback,
	loading = null,
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
	if (verified.error) return <>{fallback}</>;
	if (!objectUrl) return <>{loading}</>;
	const label = title ?? media.filename ?? "Preview";

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
	fallback,
	loading = null,
	title,
	className,
}: ViewProps) {
	const { value: text, error } = useMediaResource(media, {
		isEnabled: true,
		maxBytes: maxTextBytes,
		contentType: expectedType,
		decode: decodeText,
	});
	if (error) return <>{fallback}</>;
	if (text === null) return <>{loading}</>;
	return (
		<pre title={title} className={className}>
			{text}
		</pre>
	);
}
