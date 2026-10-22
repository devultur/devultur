"use client";

import React from "react";
import type { DevulturMedia } from "@devultur/core";
import {
	type MediaLibraryClassNames,
	MediaLibraryItem,
	type MediaLibraryItemState,
	type MediaLibraryPart,
	partClass,
} from "./media-library-item";
import { type MediaLibraryLabels, mergeMediaLibraryLabels } from "./media-library-labels";
import { mediaFromRecord } from "./media-record";
import type { MediaRecord } from "./types";
import { useMediaLibrary } from "./use-media-library";
import { useRovingFocus } from "./use-roving-focus";

export type { MediaLibraryPart };

type MediaType = MediaRecord["type"];
const MEDIA_TYPES: MediaType[] = ["image", "video", "file"];

export interface MediaLibraryProps {
	/** Called when an item is chosen (click, Enter or Space), with its reference (`null` for a record without one). */
	onSelect: (record: MediaRecord, media: DevulturMedia | null) => void;
	/** Overrides any of the strings; the rest stay English. */
	labels?: Partial<MediaLibraryLabels>;
	/** Only this kind of media; the type filter is then hidden. */
	type?: MediaType;
	/** Keeps the chosen item selected (`aria-selected`, `data-selected`), as a picker. Default `false`. */
	selectable?: boolean;
	/** Replaces an item's content (thumbnail, name and size). The item itself stays the focusable option. */
	renderItem?: (record: MediaRecord, state: MediaLibraryItemState) => React.ReactNode;
	/** Records per page. Default 24. */
	pageSize?: number;
	/**
	 * Draws page 1 of PDFs (`<PdfThumbnail>`, inside a `PdfPreviewProvider`). Each one downloads its PDF as it nears the
	 * viewport, so it's off by default: PDFs show an icon.
	 */
	pdfThumbnails?: boolean;
	/** Added to the root's `devultur-media-library` class. */
	className?: string;
	/** Added to each part's `devultur-media-library__{part}` class. */
	classNames?: MediaLibraryClassNames;
}

const ROOT_STYLE: React.CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: "var(--devultur-library-gap, 0.75rem)",
};

const LIST_STYLE: React.CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fill, minmax(var(--devultur-library-item-width, 160px), 1fr))",
	gap: "var(--devultur-library-gap, 0.75rem)",
	margin: 0,
	padding: 0,
};

/**
 * A searchable grid of the media library: a search box, a type filter and the items (a thumbnail for images, an icon,
 * the name and the size), a page at a time. Arrow keys, Home and End move between items. Needs `listMediaPage` and
 * `searchMedia` in `<DevulturProvider api>`. Unstyled but for the layout; style it through the class names and the
 * `--devultur-library-*` custom properties.
 *
 * @example
 * <MediaLibrary type="image" selectable onSelect={(record, media) => setCover(media)} />
 */
export function MediaLibrary(props: MediaLibraryProps) {
	const labels = React.useMemo(() => mergeMediaLibraryLabels(props.labels), [props.labels]);
	const classNames = { ...props.classNames, root: props.className ?? props.classNames?.root };
	const [search, setSearch] = React.useState("");
	const [chosenType, setChosenType] = React.useState<MediaType | "">("");
	const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
	const type = props.type ?? (chosenType === "" ? undefined : chosenType);
	const { onSelect } = props;
	const isSelectable = props.selectable ?? false;

	const handleChoose = React.useCallback(
		(record: MediaRecord) => {
			if (isSelectable) setSelectedKey(record.key);
			onSelect(record, mediaFromRecord(record));
		},
		[isSelectable, onSelect],
	);

	return (
		<div className={partClass("root", classNames)} style={ROOT_STYLE}>
			<input
				type="search"
				className={partClass("search", classNames)}
				aria-label={labels.search}
				placeholder={labels.searchPlaceholder}
				value={search}
				onChange={(event) => setSearch(event.target.value)}
			/>
			{!props.type && (
				<select
					className={partClass("filter", classNames)}
					aria-label={labels.typeFilter}
					value={chosenType}
					onChange={(event) => setChosenType(event.target.value as MediaType | "")}
				>
					<option value="">{labels.allTypes}</option>
					{MEDIA_TYPES.map((mediaType) => (
						<option key={mediaType} value={mediaType}>
							{labels.types[mediaType]}
						</option>
					))}
				</select>
			)}
			<LibraryErrorBoundary
				resetKey={`${type ?? ""}\u0000${search}`}
				renderError={(error, retry) => (
					<div role="alert" className={partClass("status", classNames)}>
						<p>{labels.error(error)}</p>
						<button type="button" className={partClass("more", classNames)} onClick={retry}>
							{labels.retry}
						</button>
					</div>
				)}
			>
				<LibraryResults
					{...props}
					type={type}
					search={search}
					labels={labels}
					classNames={classNames}
					isSelectable={isSelectable}
					selectedKey={selectedKey}
					onChoose={handleChoose}
				/>
			</LibraryErrorBoundary>
		</div>
	);
}

interface LibraryResultsProps extends Omit<MediaLibraryProps, "labels" | "onSelect"> {
	search: string;
	labels: MediaLibraryLabels;
	classNames: MediaLibraryClassNames;
	isSelectable: boolean;
	selectedKey: string | null;
	onChoose: (record: MediaRecord) => void;
}

function LibraryResults(props: LibraryResultsProps) {
	const { labels, classNames } = props;
	const library = useMediaLibrary({ type: props.type, search: props.search, pageSize: props.pageSize });
	const roving = useRovingFocus(library.items.length);

	if (library.status === "LoadingFirstPage") {
		return (
			<p role="status" className={partClass("status", classNames)}>
				{labels.loading}
			</p>
		);
	}
	if (library.items.length === 0) {
		return (
			<p role="status" className={partClass("status", classNames)}>
				{library.search ? labels.noResults(library.search) : labels.empty}
			</p>
		);
	}

	const isLoadingMore = library.status === "LoadingMore";
	const canLoadMore = library.status === "CanLoadMore" || isLoadingMore;
	return (
		<>
			<div
				role="listbox"
				aria-label={labels.results}
				aria-busy={isLoadingMore || undefined}
				className={partClass("list", classNames)}
				style={LIST_STYLE}
				onKeyDown={roving.handleKeyDown}
			>
				{library.items.map((record, index) => (
					<MediaLibraryItem
						key={record.key}
						ref={roving.itemRef(index)}
						record={record}
						isSelected={props.isSelectable && record.key === props.selectedKey}
						isActive={index === roving.activeIndex}
						tabIndex={roving.tabIndex(index)}
						pdfThumbnails={props.pdfThumbnails ?? false}
						labels={labels}
						classNames={classNames}
						renderItem={props.renderItem}
						onChoose={() => props.onChoose(record)}
						onFocus={() => roving.setActiveIndex(index)}
					/>
				))}
			</div>
			{canLoadMore && (
				<button
					type="button"
					className={partClass("more", classNames)}
					disabled={isLoadingMore}
					onClick={() => library.loadMore()}
				>
					{isLoadingMore ? labels.loadingMore : labels.loadMore}
				</button>
			)}
		</>
	);
}

interface LibraryErrorBoundaryProps {
	/** A new search or type clears the error. */
	resetKey: string;
	renderError: (error: unknown, retry: () => void) => React.ReactNode;
	children: React.ReactNode;
}

interface LibraryErrorBoundaryState {
	hasError: boolean;
	error: unknown;
}

// A failed Convex query throws while rendering; this shows it in place of the items, with a retry.
class LibraryErrorBoundary extends React.Component<LibraryErrorBoundaryProps, LibraryErrorBoundaryState> {
	state: LibraryErrorBoundaryState = { hasError: false, error: null };

	static getDerivedStateFromError(error: unknown): LibraryErrorBoundaryState {
		return { hasError: true, error };
	}

	componentDidUpdate(previous: LibraryErrorBoundaryProps) {
		if (previous.resetKey === this.props.resetKey || !this.state.hasError) return;
		this.setState({ hasError: false, error: null });
	}

	retry = () => this.setState({ hasError: false, error: null });

	render() {
		if (this.state.hasError) return this.props.renderError(this.state.error, this.retry);
		return this.props.children;
	}
}
