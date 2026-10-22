// `@devultur/convex/pdfjs`: the default pdf.js loader for `PdfPreviewProvider`. A separate entry so that apps
// without `pdfjs-dist` installed never bundle an import their bundler can't resolve.
import type { PdfjsModule } from "./pdf-render";

/** The worker next to the legacy build, resolved by your bundler from this package. */
export const defaultPdfWorkerSrc = () => new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).href;

/**
 * Imports the pdf.js legacy build (Safari and iOS 18+; the modern build needs iOS 26.2) and, unless a worker is set
 * already, points `GlobalWorkerOptions.workerSrc` at `defaultPdfWorkerSrc()`.
 */
export async function loadPdfjs(): Promise<PdfjsModule> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = defaultPdfWorkerSrc();
	return pdfjs;
}
