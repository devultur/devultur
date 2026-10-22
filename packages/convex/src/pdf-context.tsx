"use client";

import React from "react";
import { countPages, type PdfjsLoader, type PdfjsModule } from "./pdf-render";
import { mergePreviewLabels, type PreviewLabels } from "./preview-labels";

export interface PdfPreviewConfig {
	/**
	 * Imports pdf.js. Without it, PDFs render in an `<iframe>` (the browser's own viewer) and `<PdfThumbnail>` renders
	 * its fallback. `loadPdfjs` from `@devultur/convex/pdfjs` imports the legacy build and sets a default worker.
	 */
	pdfjs?: PdfjsLoader;
	/** URL of `pdf.worker.min.mjs`, set on `GlobalWorkerOptions.workerSrc` before a document opens. */
	workerSrc?: string;
	/** Labels for every `<Preview>` and `<PdfThumbnail>` below it; a component's own `labels` win over these. */
	labels?: Partial<PreviewLabels>;
}

const PdfPreviewContext = React.createContext<PdfPreviewConfig>({});

/**
 * Renders the PDFs of every `<Preview>` and `<PdfThumbnail>` below it with pdf.js, on a `<canvas>`, and gives them
 * default `labels`.
 *
 * @example
 * import { loadPdfjs } from "@devultur/convex/pdfjs";
 * <PdfPreviewProvider pdfjs={loadPdfjs}>{children}</PdfPreviewProvider>
 */
export function PdfPreviewProvider({
	pdfjs,
	workerSrc,
	labels,
	children,
}: PdfPreviewConfig & { children: React.ReactNode }) {
	const config = React.useMemo(() => ({ pdfjs, workerSrc, labels }), [pdfjs, workerSrc, labels]);
	return <PdfPreviewContext.Provider value={config}>{children}</PdfPreviewContext.Provider>;
}

export type PdfjsState =
	| { status: "loading" }
	| { status: "ready"; pdfjs: PdfjsModule; workerSrc?: string }
	| { status: "unavailable" };

// One import per loader, shared by every preview on the page.
const loadedModules = new WeakMap<PdfjsLoader, Promise<PdfjsModule | null>>();

function loadOnce(loader: PdfjsLoader): Promise<PdfjsModule | null> {
	const cached = loadedModules.get(loader);
	if (cached) return cached;
	const loading = loader().catch(() => null);
	loadedModules.set(loader, loading);
	return loading;
}

/** pdf.js from the nearest `PdfPreviewProvider`; `unavailable` when none is configured or the import fails. */
export function usePdfjs(workerSrcOverride?: string): PdfjsState {
	const { pdfjs: loader, workerSrc } = React.useContext(PdfPreviewContext);
	const [loaded, setLoaded] = React.useState<{ loader: PdfjsLoader; pdfjs: PdfjsModule | null } | null>(null);

	React.useEffect(() => {
		if (!loader) return;
		let isCurrent = true;
		loadOnce(loader).then((pdfjs) => {
			if (isCurrent) setLoaded({ loader, pdfjs });
		});
		return () => {
			isCurrent = false;
		};
	}, [loader]);

	if (!loader) return { status: "unavailable" };
	if (loaded?.loader !== loader) return { status: "loading" };
	if (!loaded.pdfjs) return { status: "unavailable" };
	return { status: "ready", pdfjs: loaded.pdfjs, workerSrc: workerSrcOverride ?? workerSrc };
}

/** Counts a PDF's pages: a file's page count, or `null` when it can't be read. */
export type PdfPageCounter = (file: Blob) => Promise<number | null>;

/**
 * A page counter on the nearest `PdfPreviewProvider`'s pdf.js, imported on the first count; `null` when none is
 * configured.
 */
export function usePdfPageCounter(): PdfPageCounter | null {
	const { pdfjs: loader, workerSrc } = React.useContext(PdfPreviewContext);
	return React.useMemo(() => {
		if (!loader) return null;
		return async (file: Blob) => {
			const pdfjs = await loadOnce(loader);
			if (!pdfjs) return null;
			return countPages(pdfjs, file, workerSrc);
		};
	}, [loader, workerSrc]);
}

/** The English defaults, overridden by the nearest provider's `labels`, then by the component's own. */
export function usePreviewLabels(labels?: Partial<PreviewLabels>): PreviewLabels {
	const providerLabels = React.useContext(PdfPreviewContext).labels;
	return mergePreviewLabels(providerLabels, labels);
}
