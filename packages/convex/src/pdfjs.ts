// `@devultur/convex/pdfjs`: the default pdf.js loader for `PdfPreviewProvider`, and `countPdfPages` for uploads. A
// separate entry so that apps without `pdfjs-dist` installed never bundle an import their bundler can't resolve.
import { openPdf, type PdfjsLoader, type PdfjsModule } from "./pdf-render";

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

/**
 * A PDF's page count, read in the browser with pdf.js (imported on the first call), or `null` when the file isn't a
 * PDF pdf.js can open. Pass it as `pageCount` to `upload()` or `confirmUpload`: it's recorded as the client's hint.
 *
 * @example
 * const pageCount = (await countPdfPages(file)) ?? undefined;
 * await upload(file, { pageCount });
 */
export async function countPdfPages(file: Blob, options?: { loadPdfjs?: PdfjsLoader }): Promise<number | null> {
	const pdfjs = await (options?.loadPdfjs ?? loadPdfjs)();
	const task = openPdf(pdfjs, new Uint8Array(await file.arrayBuffer()));
	try {
		const document = await task.promise;
		return document.numPages;
	} catch {
		return null;
	} finally {
		await task.destroy();
	}
}
