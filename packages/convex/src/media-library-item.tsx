"use client";

import React from "react";
import type { DevulturMedia } from "@devultur/core";
import { AttachmentIcon } from "./attachment-icons";
import type { AttachmentKind } from "./attachment-labels";
import { Image } from "./image";
import type { MediaLibraryLabels } from "./media-library-labels";
import { mediaFromRecord } from "./media-record";
import { PdfThumbnail } from "./pdf-thumbnail";
import { previewKindOf } from "./preview-type";
import type { MediaRecord } from "./types";

const THUMBNAIL_WIDTH = 160;
// 1x and 2x of the thumbnail's width, for high-density screens.
const THUMBNAIL_WIDTHS = [THUMBNAIL_WIDTH, THUMBNAIL_WIDTH * 2];

/** What `renderItem` gets besides the record. */
export interface MediaLibraryItemState {
	/** The record's reference (`mediaFromRecord`), `null` for a record without a visibility. */
	media: DevulturMedia | null;
	/** Chosen (only with `selectable`). */
	isSelected: boolean;
	/** The item the arrow keys move from (the one in the tab order). */
	isActive: boolean;
}

/** The parts of `<MediaLibrary>` that have a class name (`devultur-media-library__{part}`, `root`'s without the suffix). */
export type MediaLibraryPart =
	| "root"
	| "search"
	| "filter"
	| "list"
	| "item"
	| "thumbnail"
	| "name"
	| "size"
	| "status"
	| "more";

export type MediaLibraryClassNames = Partial<Record<MediaLibraryPart, string>>;

/** A part's own class, then the app's. */
export function partClass(part: MediaLibraryPart, classNames: MediaLibraryClassNames): string {
	const own = part === "root" ? "devultur-media-library" : `devultur-media-library__${part}`;
	const extra = classNames[part];
	return extra ? `${own} ${extra}` : own;
}

interface MediaLibraryItemProps {
	ref?: React.Ref<HTMLDivElement>;
	record: MediaRecord;
	isSelected: boolean;
	isActive: boolean;
	tabIndex: number;
	pdfThumbnails: boolean;
	labels: MediaLibraryLabels;
	classNames: MediaLibraryClassNames;
	renderItem?: (record: MediaRecord, state: MediaLibraryItemState) => React.ReactNode;
	onChoose: () => void;
	onFocus: () => void;
}

const THUMBNAIL_STYLE: React.CSSProperties = {
	display: "block",
	width: "100%",
	height: "var(--devultur-library-thumbnail-height, 120px)",
	objectFit: "cover",
};

/** An image, a video, or what a file's content type says it is (a PDF, audio, text). */
function kindOf(record: MediaRecord): AttachmentKind {
	if (record.type !== "file") return record.type;
	return previewKindOf(record.contentType) ?? "file";
}

interface ThumbnailProps {
	record: MediaRecord;
	media: DevulturMedia | null;
	pdfThumbnails: boolean;
}

function Thumbnail({ record, media, pdfThumbnails }: ThumbnailProps) {
	const kind = kindOf(record);
	const icon = <AttachmentIcon kind={kind} />;
	if (!media) return icon;
	// Only an image upload gets transforms; a file that holds an image keeps its icon.
	if (record.type === "image") {
		return (
			<Image
				media={media}
				width={THUMBNAIL_WIDTH}
				widths={THUMBNAIL_WIDTHS}
				sizes={`${THUMBNAIL_WIDTH}px`}
				format="auto"
				alt=""
				style={THUMBNAIL_STYLE}
				fallback={icon}
			/>
		);
	}
	if (kind !== "pdf" || !pdfThumbnails) return icon;
	return <PdfThumbnail media={media} contentType={record.contentType} width={THUMBNAIL_WIDTH} fallback={icon} />;
}

interface DefaultContentProps {
	record: MediaRecord;
	media: DevulturMedia | null;
	pdfThumbnails: boolean;
	labels: MediaLibraryLabels;
	classNames: MediaLibraryClassNames;
}

function DefaultContent({ record, media, pdfThumbnails, labels, classNames }: DefaultContentProps) {
	const name = record.title ?? record.filename;
	return (
		<>
			<span className={partClass("thumbnail", classNames)}>
				<Thumbnail record={record} media={media} pdfThumbnails={pdfThumbnails} />
			</span>
			<span className={partClass("name", classNames)}>{name}</span>
			{record.sizeBytes > 0 && <span className={partClass("size", classNames)}>{labels.size(record.sizeBytes)}</span>}
		</>
	);
}

const ITEM_STYLE: React.CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: "var(--devultur-library-item-gap, 0.25rem)",
	cursor: "pointer",
	overflowWrap: "anywhere",
};

/** One option of the library: Enter, Space or a click chooses it. */
export function MediaLibraryItem(props: MediaLibraryItemProps) {
	const { ref, record, isSelected, isActive, tabIndex, classNames, renderItem, onChoose, onFocus } = props;
	const media = React.useMemo(() => mediaFromRecord(record), [record]);

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		onChoose();
	};

	return (
		<div
			ref={ref}
			role="option"
			aria-selected={isSelected}
			tabIndex={tabIndex}
			data-selected={isSelected || undefined}
			data-type={record.type}
			className={partClass("item", classNames)}
			style={{
				...ITEM_STYLE,
				boxShadow: isSelected ? "0 0 0 2px var(--devultur-library-accent, currentColor)" : undefined,
			}}
			onClick={onChoose}
			onKeyDown={handleKeyDown}
			onFocus={onFocus}
		>
			{renderItem ? (
				renderItem(record, { media, isSelected, isActive })
			) : (
				<DefaultContent
					record={record}
					media={media}
					pdfThumbnails={props.pdfThumbnails}
					labels={props.labels}
					classNames={classNames}
				/>
			)}
		</div>
	);
}
