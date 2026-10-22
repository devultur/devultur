"use client";

import React from "react";
import {
	isRenderCancelled,
	openPdf,
	type PdfDocument,
	type PdfjsModule,
	type PdfPage,
	type PdfRenderTask,
	pageText,
	renderPage,
} from "./pdf-render";

/** `true` once the element has come within `rootMargin` of the viewport (and stays `true`). */
export function useIsVisible(ref: React.RefObject<Element | null>, rootMargin = "200px"): boolean {
	const [isVisible, setIsVisible] = React.useState(false);

	React.useEffect(() => {
		const element = ref.current;
		if (isVisible || !element) return;
		// No IntersectionObserver (old engines, some test environments): render eagerly.
		if (typeof IntersectionObserver === "undefined") {
			setIsVisible(true);
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				setIsVisible(true);
				observer.disconnect();
			},
			{ rootMargin },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref, rootMargin, isVisible]);

	return isVisible;
}

export interface PdfDocumentState {
	document: PdfDocument | null;
	error: Error | null;
}

interface PdfDocumentOptions {
	pdfjs: PdfjsModule;
	bytes: Uint8Array;
	workerSrc?: string;
}

/** Opens `bytes` with pdf.js, and destroys the document (worker, fonts, caches) on change and unmount. */
export function usePdfDocument({ pdfjs, bytes, workerSrc }: PdfDocumentOptions): PdfDocumentState {
	const [state, setState] = React.useState<PdfDocumentState & { bytes: Uint8Array | null }>({
		bytes: null,
		document: null,
		error: null,
	});

	React.useEffect(() => {
		let isCurrent = true;
		const loadingTask = openPdf(pdfjs, bytes, workerSrc);
		loadingTask.promise
			.then((document) => {
				if (isCurrent) setState({ bytes, document, error: null });
			})
			.catch((error: unknown) => {
				if (!isCurrent) return;
				setState({ bytes, document: null, error: error instanceof Error ? error : new Error(String(error)) });
			});
		return () => {
			isCurrent = false;
			void loadingTask.destroy();
		};
	}, [pdfjs, bytes, workerSrc]);

	if (state.bytes !== bytes) return { document: null, error: null };
	return { document: state.document, error: state.error };
}

interface PageRenderOptions {
	document: PdfDocument | null;
	pageNumber: number;
	canvasRef: React.RefObject<HTMLCanvasElement | null>;
	/** CSS width of the canvas; 0 → the page's own width. */
	width: number;
	isEnabled: boolean;
	/** Also extract the page's text, for screen readers. */
	shouldExtractText?: boolean;
}

export interface PageRenderState {
	isRendered: boolean;
	text: string;
}

/** Renders one page into `canvasRef` while enabled; cancels the render and frees the page on change and unmount. */
export function usePageRender(options: PageRenderOptions): PageRenderState {
	const { document, pageNumber, canvasRef, width, isEnabled, shouldExtractText = false } = options;
	const [state, setState] = React.useState<PageRenderState>({ isRendered: false, text: "" });

	React.useEffect(() => {
		const canvas = canvasRef.current;
		if (!document || !isEnabled || !canvas) return;
		let isCurrent = true;
		let page: PdfPage | null = null;
		let renderTask: PdfRenderTask | null = null;

		const draw = async () => {
			page = await document.getPage(pageNumber);
			if (!isCurrent) return;
			renderTask = renderPage(page, canvas, width);
			await renderTask.promise;
			if (isCurrent) setState((previous) => ({ ...previous, isRendered: true }));
			if (!shouldExtractText) return;
			const text = await pageText(page);
			if (isCurrent) setState((previous) => ({ ...previous, text }));
		};
		draw().catch((error: unknown) => {
			if (isRenderCancelled(error) || !isCurrent) return;
			console.warn(`[devultur] PDF page ${pageNumber} failed to render`, error);
		});

		return () => {
			isCurrent = false;
			renderTask?.cancel();
			page?.cleanup();
		};
	}, [document, pageNumber, canvasRef, width, isEnabled, shouldExtractText]);

	return state;
}
