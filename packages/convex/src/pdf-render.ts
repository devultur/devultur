// pdf.js glue for `<Preview>` and `<PdfThumbnail>`, with no React. The module is described structurally, so this
// package's types don't depend on `pdfjs-dist` (an optional peer dependency).

export interface PdfViewport {
	width: number;
	height: number;
}

export interface PdfRenderTask {
	promise: Promise<void>;
	cancel(): void;
}

export interface PdfPage {
	getViewport(parameters: { scale: number }): PdfViewport;
	render(parameters: { canvas: HTMLCanvasElement | null; viewport: PdfViewport }): PdfRenderTask;
	getTextContent(): Promise<{ items: ReadonlyArray<object> }>;
	cleanup(): unknown;
}

export interface PdfDocument {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPage>;
}

export interface PdfLoadingTask {
	promise: Promise<PdfDocument>;
	/** Destroys the document and its worker (pdf.js 6 has no `PDFDocumentProxy.destroy`). */
	destroy(): Promise<void>;
}

/** The parts of `pdfjs-dist` (legacy build) that the previews use. */
export interface PdfjsModule {
	GlobalWorkerOptions: { workerSrc: string };
	getDocument(source: { data: Uint8Array }): PdfLoadingTask;
}

/** Imports pdf.js, e.g. `() => import("pdfjs-dist/legacy/build/pdf.mjs")`. */
export type PdfjsLoader = () => Promise<PdfjsModule>;

/** The pdf.js viewer's own cap on iOS and Android: larger canvases run out of memory and render blank. */
export const MOBILE_MAX_CANVAS_PIXELS = 5_242_880;
/** The pdf.js viewer's desktop default. */
export const DESKTOP_MAX_CANVAS_PIXELS = 2 ** 25;

/**
 * Opens a PDF from bytes already fetched and type-verified: pdf.js never sees a URL, so it never fetches anything.
 * The bytes are copied because pdf.js transfers its buffer to the worker.
 */
export function openPdf(pdfjs: PdfjsModule, bytes: Uint8Array, workerSrc?: string): PdfLoadingTask {
	if (workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
	// pdf.js 6 only reads `enableScripting` in the annotation layer, which is never built here (CVE-2026-16633 needs
	// it on). It's passed anyway so a release that reads it at load time keeps PDF JavaScript off.
	// `isEvalSupported` (CVE-2024-4367) was removed in 5.7.284 with the PostScript compiler: the 6.4.299 legacy build
	// and worker never read it and contain no `eval` or `new Function`. Passed anyway: unknown options are ignored.
	const source = { data: bytes.slice(), enableScripting: false, isEvalSupported: false };
	return pdfjs.getDocument(source);
}

/** A PDF's page count, or `null` when pdf.js can't open it. The document is freed either way. */
export async function countPages(pdfjs: PdfjsModule, file: Blob, workerSrc?: string): Promise<number | null> {
	const task = openPdf(pdfjs, new Uint8Array(await file.arrayBuffer()), workerSrc);
	try {
		const document = await task.promise;
		return document.numPages;
	} catch {
		return null;
	} finally {
		await task.destroy();
	}
}

function isMobileDevice(): boolean {
	if (typeof navigator === "undefined") return false;
	// iPadOS reports a desktop Mac user agent, but has touch points.
	return /Android|iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
}

export function maxCanvasPixels(): number {
	return isMobileDevice() ? MOBILE_MAX_CANVAS_PIXELS : DESKTOP_MAX_CANVAS_PIXELS;
}

/** The device-pixel scale for a canvas of `cssWidth` × `cssHeight`, lowered until it fits `maxPixels`. */
export function outputScale(cssWidth: number, cssHeight: number, maxPixels: number): number {
	const devicePixelRatio = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
	const cssPixels = cssWidth * cssHeight;
	if (cssPixels <= 0) return devicePixelRatio;
	if (cssPixels * devicePixelRatio ** 2 <= maxPixels) return devicePixelRatio;
	return Math.sqrt(maxPixels / cssPixels);
}

/**
 * Renders a page into `canvas` at `cssWidth` CSS pixels wide (the page's own width when 0), sharp on high-density
 * screens within the canvas pixel cap. Returns the render task so the caller can cancel it.
 */
export function renderPage(page: PdfPage, canvas: HTMLCanvasElement, cssWidth: number): PdfRenderTask {
	const naturalViewport = page.getViewport({ scale: 1 });
	const cssScale = cssWidth > 0 ? cssWidth / naturalViewport.width : 1;
	const cssViewport = page.getViewport({ scale: cssScale });
	const scale = outputScale(cssViewport.width, cssViewport.height, maxCanvasPixels());
	const viewport = page.getViewport({ scale: cssScale * scale });
	canvas.width = Math.floor(viewport.width);
	canvas.height = Math.floor(viewport.height);
	canvas.style.width = `${Math.floor(cssViewport.width)}px`;
	canvas.style.height = `${Math.floor(cssViewport.height)}px`;
	return page.render({ canvas, viewport });
}

/** The page's text, for screen readers (the canvas itself has none). */
export async function pageText(page: PdfPage): Promise<string> {
	const { items } = await page.getTextContent();
	return items
		.map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

/** pdf.js rejects a cancelled render with `RenderingCancelledException`: not an error worth showing. */
export const isRenderCancelled = (error: unknown) =>
	error instanceof Error && error.name === "RenderingCancelledException";
