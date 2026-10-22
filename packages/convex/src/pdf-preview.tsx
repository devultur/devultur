"use client";

import React from "react";
import type { DevulturMedia } from "@devultur/core";
import { useMediaResource } from "./media-resource";
import { usePdfjs } from "./pdf-context";
import { useIsVisible, usePageRender, usePdfDocument } from "./pdf-hooks";
import type { PdfDocument, PdfjsModule } from "./pdf-render";

/** Hidden from sight, read by screen readers: the canvas carries no text of its own. */
export const VISUALLY_HIDDEN: React.CSSProperties = {
	position: "absolute",
	width: 1,
	height: 1,
	margin: -1,
	padding: 0,
	overflow: "hidden",
	clip: "rect(0 0 0 0)",
	whiteSpace: "nowrap",
	border: 0,
};

/** The body as fetched: pdf.js and the iframe fallback both start from these bytes, so there's no second fetch. */
export const keepBytes = (bytes: Uint8Array<ArrayBuffer>) => bytes;

export interface PdfPreviewProps {
	media: DevulturMedia;
	expectedType: string;
	maxBytes: number;
	fallback: React.ReactNode;
	loading: React.ReactNode;
	title?: string;
	className?: string;
	pdfWorkerSrc?: string;
}

/** A PDF on canvases with pdf.js when a `PdfPreviewProvider` supplies it, else in the browser's viewer. */
export function PdfPreview(props: PdfPreviewProps) {
	const { media, expectedType, maxBytes, fallback, loading, title, className, pdfWorkerSrc } = props;
	const pdfjsState = usePdfjs(pdfWorkerSrc);
	const { value: bytes, error } = useMediaResource(media, {
		isEnabled: true,
		maxBytes,
		contentType: expectedType,
		decode: keepBytes,
	});
	if (error) return <>{fallback}</>;
	if (!bytes || pdfjsState.status === "loading") return <>{loading}</>;
	const label = title ?? media.filename ?? "PDF";
	if (pdfjsState.status === "unavailable") return <PdfFrame bytes={bytes} label={label} className={className} />;
	return (
		<PdfCanvasDocument
			pdfjs={pdfjsState.pdfjs}
			workerSrc={pdfjsState.workerSrc}
			bytes={bytes}
			label={label}
			className={className}
			fallback={fallback}
			loading={loading}
		/>
	);
}

interface PdfCanvasDocumentProps {
	pdfjs: PdfjsModule;
	workerSrc?: string;
	bytes: Uint8Array;
	label: string;
	className?: string;
	fallback: React.ReactNode;
	loading: React.ReactNode;
}

function PdfCanvasDocument({ pdfjs, workerSrc, bytes, label, className, fallback, loading }: PdfCanvasDocumentProps) {
	const { document, error } = usePdfDocument({ pdfjs, bytes, workerSrc });
	const containerRef = React.useRef<HTMLDivElement>(null);
	// Measured once the container exists; pages wait for it so none renders twice.
	const [width, setWidth] = React.useState<number | null>(null);

	React.useLayoutEffect(() => {
		if (document) setWidth(containerRef.current?.clientWidth ?? 0);
	}, [document]);

	if (error) return <>{fallback}</>;
	if (!document) return <>{loading}</>;
	const pageNumbers = Array.from({ length: document.numPages }, (_, index) => index + 1);
	const pageCountLabel = document.numPages === 1 ? "1 page" : `${document.numPages} pages`;
	return (
		<div ref={containerRef} role="document" aria-label={`${label}, ${pageCountLabel}`} className={className}>
			{width !== null &&
				pageNumbers.map((pageNumber) => (
					<PdfPageView key={pageNumber} document={document} pageNumber={pageNumber} width={width} />
				))}
		</div>
	);
}

interface PdfPageViewProps {
	document: PdfDocument;
	pageNumber: number;
	width: number;
}

// A page renders once it nears the viewport; until then an A4-shaped placeholder holds its place in the scroll.
function PdfPageView({ document, pageNumber, width }: PdfPageViewProps) {
	const pageRef = React.useRef<HTMLElement>(null);
	const canvasRef = React.useRef<HTMLCanvasElement>(null);
	const isVisible = useIsVisible(pageRef);
	const { isRendered, text } = usePageRender({
		document,
		pageNumber,
		canvasRef,
		width,
		isEnabled: isVisible,
		shouldExtractText: true,
	});
	const placeholderStyle = isRendered ? undefined : { aspectRatio: "1 / 1.4142", maxWidth: "100%" };
	return (
		<section ref={pageRef} aria-label={`Page ${pageNumber} of ${document.numPages}`} style={placeholderStyle}>
			<canvas ref={canvasRef} style={{ display: "block", maxWidth: "100%" }} />
			{text && <p style={VISUALLY_HIDDEN}>{text}</p>}
		</section>
	);
}

// `<iframe>` over `<object type="application/pdf">`: the blob's type is already forced to `application/pdf`, so
// `<object>`'s `type` adds nothing, while `<iframe>` loads like a navigation in every browser (iOS Safari shows only
// a first-page image in an `<object>`) and takes a `title` as its accessible name.
// No `sandbox`: Chrome refuses to load its PDF viewer in a sandboxed frame and Firefox's viewer needs scripts, so a
// sandbox breaks every PDF. The protection is the type: a blob typed `application/pdf` opens in the browser's PDF
// viewer, never as HTML, so a non-PDF body fails to parse instead of running script in the app's origin.
// `no-referrer`: the viewer never learns the app page that framed the document.
function PdfFrame({ bytes, label, className }: { bytes: Uint8Array<ArrayBuffer>; label: string; className?: string }) {
	const [objectUrl, setObjectUrl] = React.useState<string | null>(null);

	React.useEffect(() => {
		const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
		setObjectUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [bytes]);

	if (!objectUrl) return null;
	return <iframe src={objectUrl} title={label} referrerPolicy="no-referrer" className={className} />;
}
