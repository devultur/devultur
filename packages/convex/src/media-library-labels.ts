import { formatFileSize } from "./attachment-labels";
import { describeDevulturError } from "./error-labels";
import type { MediaRecord } from "./types";

type MediaType = MediaRecord["type"];

/** Every string `<MediaLibrary>` shows or announces. Pass any subset as `labels`; the rest stay English. */
export interface MediaLibraryLabels {
	/** Accessible name of the search box. */
	search: string;
	searchPlaceholder: string;
	/** Accessible name of the type filter. */
	typeFilter: string;
	/** The type filter's option for every kind. */
	allTypes: string;
	types: Record<MediaType, string>;
	/** Accessible name of the list of media. */
	results: string;
	/** Shown while the first page loads. */
	loading: string;
	/** The library has nothing (of this type). */
	empty: string;
	/** Nothing matches the search. */
	noResults: (search: string) => string;
	loadMore: string;
	/** The load-more button while the next page loads. */
	loadingMore: string;
	/** Shown when the library couldn't be loaded. Default: the Devultur error's message, if it is one. */
	error: (error: unknown) => string;
	retry: string;
	/** A record's size. Not shown for a size of 0 (a video only `processVideo` recorded). */
	size: (bytes: number) => string;
}

export const defaultMediaLibraryLabels: MediaLibraryLabels = {
	search: "Search media",
	searchPlaceholder: "Search by title or filename",
	typeFilter: "Type",
	allTypes: "All types",
	types: { image: "Images", video: "Videos", file: "Files" },
	results: "Media",
	loading: "Loading media…",
	empty: "No media yet.",
	noResults: (search) => `Nothing matches “${search}”.`,
	loadMore: "Load more",
	loadingMore: "Loading…",
	error: (error) => describeDevulturError(error) ?? "The media couldn't be loaded.",
	retry: "Try again",
	size: (bytes) => formatFileSize(bytes, "en"),
};

/** The defaults with `labels` over them; a key set to `undefined` keeps the default. */
export function mergeMediaLibraryLabels(labels: Partial<MediaLibraryLabels> | undefined): MediaLibraryLabels {
	const merged: Record<string, unknown> = { ...defaultMediaLibraryLabels };
	for (const [key, value] of Object.entries(labels ?? {})) {
		if (value !== undefined) merged[key] = value;
	}
	return merged as unknown as MediaLibraryLabels;
}
