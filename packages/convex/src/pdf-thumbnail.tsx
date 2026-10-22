"use client";

import React from "react";
import type { DevulturMedia } from "@devultur/core";
import { useMediaResource } from "./media-resource";
import { usePdfjs, usePreviewLabels } from "./pdf-context";
import { useIsVisible, usePageRender, usePdfDocument } from "./pdf-hooks";
import { keepBytes } from "./pdf-preview";
import type { PdfjsModule } from "./pdf-render";
import type { PreviewLabels } from "./preview-labels";
import { expectedContentType, previewKindOf } from "./preview-type";

const DEFAULT_THUMBNAIL_WIDTH = 96;
const DEFAULT_THUMBNAIL_MAX_BYTES = 50 * 1024 * 1024;

export interface PdfThumbnailProps {
	/** Typed reference. `null`/`undefined` → renders nothing. */
	media: DevulturMedia | null | undefined;
	/** The type you know the media has. Default: inferred from `media.filename`'s extension. */
	contentType?: string;
	/** CSS width of the thumbnail in pixels; the height follows the page. Default 96. */
	width?: number;
	/** Larger files render `fallback`. Default 50 MiB. */
	maxBytes?: number;
	/** Shown when the media isn't a PDF, pdf.js isn't available (no `PdfPreviewProvider`) or loading fails. */
	fallback?: React.ReactNode;
	/** Shown until page 1 is drawn, including while off-screen. Default: nothing. */
	loading?: React.ReactNode;
	/** Title the accessible name is built from (`labels.thumbnail`). Default: the filename. */
	title?: string;
	className?: string;
	/** Overrides the provider's `workerSrc`. */
	pdfWorkerSrc?: string;
	/** Overrides `thumbnail` and `untitledPdf`; wins over `PdfPreviewProvider`'s `labels`. English by default. */
	labels?: Partial<PreviewLabels>;
}

/**
 * Page 1 of a PDF on a small canvas, for lists and upload queues. Nothing is fetched until it nears the viewport.
 * Needs pdf.js from a `PdfPreviewProvider`; without it, renders `fallback`.
 *
 * @example
 * <PdfThumbnail media={row.file} width={64} fallback={<FileIcon />} />
 */
export function PdfThumbnail(props: PdfThumbnailProps) {
	const { media, contentType, width = DEFAULT_THUMBNAIL_WIDTH, fallback = null, loading = null } = props;
	const containerRef = React.useRef<HTMLDivElement>(null);
	const isVisible = useIsVisible(containerRef);
	const pdfjsState = usePdfjs(props.pdfWorkerSrc);
	const labels = usePreviewLabels(props.labels);
	const expectedType = media ? expectedContentType(media, contentType) : null;
	const isPdf = previewKindOf(expectedType) === "pdf";
	const { value: bytes, error } = useMediaResource(media, {
		isEnabled: isVisible && isPdf && pdfjsState.status === "ready",
		maxBytes: props.maxBytes ?? DEFAULT_THUMBNAIL_MAX_BYTES,
		contentType: expectedType ?? undefined,
		decode: keepBytes,
	});
	if (!media) return null;

	const isUnavailable = !isPdf || pdfjsState.status === "unavailable" || error !== null;
	const content = () => {
		if (isUnavailable) return fallback;
		if (!bytes || pdfjsState.status !== "ready") return loading;
		return (
			<ThumbnailCanvas
				pdfjs={pdfjsState.pdfjs}
				workerSrc={pdfjsState.workerSrc}
				bytes={bytes}
				width={width}
				label={labels.thumbnail(props.title ?? media.filename ?? labels.untitledPdf)}
				fallback={fallback}
				loading={loading}
			/>
		);
	};
	return (
		<div ref={containerRef} className={props.className} style={{ width }}>
			{content()}
		</div>
	);
}

interface ThumbnailCanvasProps {
	pdfjs: PdfjsModule;
	workerSrc?: string;
	bytes: Uint8Array;
	width: number;
	label: string;
	fallback: React.ReactNode;
	loading: React.ReactNode;
}

function ThumbnailCanvas({ pdfjs, workerSrc, bytes, width, label, fallback, loading }: ThumbnailCanvasProps) {
	const canvasRef = React.useRef<HTMLCanvasElement>(null);
	const { document, error } = usePdfDocument({ pdfjs, bytes, workerSrc });
	const { isRendered } = usePageRender({ document, pageNumber: 1, canvasRef, width, isEnabled: true });
	if (error) return <>{fallback}</>;
	return (
		<>
			{!isRendered && loading}
			<canvas ref={canvasRef} role="img" aria-label={label} style={{ display: "block" }} />
		</>
	);
}
