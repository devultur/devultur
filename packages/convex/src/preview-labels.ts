import type { MediaFetchErrorCode } from "./media-fetch";

/**
 * Every string `<Preview>`, `<PdfThumbnail>` and their PDF pages show or announce. Pass any subset as `labels` on a
 * component or on `PdfPreviewProvider`; the component's wins over the provider's, which wins over the English defaults.
 */
export interface PreviewLabels {
	/** Accessible name of a pdf.js document: its title and page count. */
	document: (title: string, pageCount: number) => string;
	/** Accessible name of one pdf.js page. */
	page: (page: number, pageCount: number) => string;
	/** Announced (visually hidden) while a preview loads, when no `loading` is passed. */
	loading: string;
	/** Note after the last rendered page when a PDF has more than `maxPages`; `fallback` follows it. */
	pageCap: (shown: number, total: number) => string;
	/** `title` of the default fallback's download link when a fetch was refused or the type can't be previewed. */
	error: (code: MediaFetchErrorCode) => string;
	/** Accessible name of a `<PdfThumbnail>`, from its title. */
	thumbnail: (title: string) => string;
	/** Name of a PDF (pdf.js document, `<iframe>` title, thumbnail) with no `title` and no filename. */
	untitledPdf: string;
	/** Name of an image or audio preview with no `title` and no filename. */
	untitledMedia: string;
	/** Text of the default fallback's download link when the media has no filename. */
	download: string;
}

const ERROR_TEXT: Record<MediaFetchErrorCode, string> = {
	http_error: "The file couldn't be loaded.",
	too_large: "The file is too large to preview.",
	unsupported_type: "This file type can't be previewed.",
	type_mismatch: "The file's content doesn't match its type.",
};

export const defaultPreviewLabels: PreviewLabels = {
	document: (title, pageCount) => `${title}, ${pageCount === 1 ? "1 page" : `${pageCount} pages`}`,
	page: (page, pageCount) => `Page ${page} of ${pageCount}`,
	loading: "Loading…",
	pageCap: (shown, total) => `Showing the first ${shown} of ${total} pages.`,
	error: (code) => ERROR_TEXT[code],
	thumbnail: (title) => title,
	untitledPdf: "PDF",
	untitledMedia: "Preview",
	download: "Download",
};

/** Later sources win; a key set to `undefined` keeps the earlier value instead of erasing it. */
export function mergePreviewLabels(...sources: Array<Partial<PreviewLabels> | undefined>): PreviewLabels {
	const merged: Record<string, unknown> = { ...defaultPreviewLabels };
	for (const source of sources) {
		for (const [key, value] of Object.entries(source ?? {})) {
			if (value !== undefined) merged[key] = value;
		}
	}
	return merged as unknown as PreviewLabels;
}
