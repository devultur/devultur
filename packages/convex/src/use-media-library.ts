"use client";

import React from "react";
import { usePaginatedQuery } from "convex/react";
import { useDevulturApi } from "./react";
import type { MediaRecord } from "./types";

type MediaType = MediaRecord["type"];

export const SEARCH_DEBOUNCE_MS = 250;
const DEFAULT_PAGE_SIZE = 24;

export interface UseMediaLibraryOptions {
	/** Only this kind of media. Default: every kind. */
	type?: MediaType;
	/** Matches the title and filename. Debounced 250 ms; clearing it applies at once. Blank → newest first. */
	search?: string;
	/** Records in the first page and in each `loadMore()`. Default 24. */
	pageSize?: number;
}

/** Convex's pagination status. */
export type MediaLibraryStatus = "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

export interface MediaLibraryState {
	/** The records loaded so far: newest first, or best match first while searching. */
	items: MediaRecord[];
	status: MediaLibraryStatus;
	/** Loads `numItems` more (default `pageSize`). Does nothing unless `status` is `"CanLoadMore"`. */
	loadMore: (numItems?: number) => void;
	/** The first page or a further one is loading. */
	isLoading: boolean;
	/** The search the items are for (the debounced `search`, trimmed). */
	search: string;
	/** `search` changed and the debounce hasn't applied it yet. */
	isSearchPending: boolean;
}

/** `value` once it has stayed the same for `delayMs`; an empty one applies at once. */
function useDebouncedSearch(value: string, delayMs: number): string {
	const [debounced, setDebounced] = React.useState(value);
	React.useEffect(() => {
		if (value === "") {
			setDebounced("");
			return;
		}
		const timer = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(timer);
	}, [value, delayMs]);
	return value === "" ? "" : debounced;
}

/**
 * The media library a page at a time, from the `listMediaPage` and `searchMedia` your `<DevulturProvider api>`
 * passes. A new search or type starts again from the first page. Like Convex's `usePaginatedQuery`, a failed query
 * throws to the nearest error boundary (`<MediaLibrary>` has its own).
 *
 * @example
 * const { items, status, loadMore } = useMediaLibrary({ type: "image", search });
 */
export function useMediaLibrary(options: UseMediaLibraryOptions = {}): MediaLibraryState {
	const api = useDevulturApi();
	const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
	const requestedSearch = (options.search ?? "").trim();
	const search = useDebouncedSearch(requestedSearch, SEARCH_DEBOUNCE_MS);
	const isSearching = search !== "";
	const typeArg = options.type ? { type: options.type } : {};

	const reference = isSearching ? api.searchMedia : api.listMediaPage;
	if (!reference) {
		const missing = isSearching ? "searchMedia" : "listMediaPage";
		throw new Error(`useMediaLibrary requires ${missing} in DevulturProvider api`);
	}
	const args = isSearching ? { search, ...typeArg } : typeArg;
	const result = usePaginatedQuery(reference as never, args as never, { initialNumItems: pageSize });

	const resultLoadMore = result.loadMore;
	const loadMore = React.useCallback(
		(numItems?: number) => resultLoadMore(numItems ?? pageSize),
		[resultLoadMore, pageSize],
	);

	return {
		items: result.results as MediaRecord[],
		status: result.status,
		loadMore,
		isLoading: result.isLoading,
		search,
		isSearchPending: requestedSearch !== search,
	};
}
