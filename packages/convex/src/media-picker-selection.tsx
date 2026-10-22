"use client";

import React from "react";
import type { DevulturMedia } from "@devultur/core";
import { AttachmentCard } from "./document-renderers";
import { Image } from "./image";
import { mediaName, useMediaPicker } from "./media-picker-context";
import { Preview } from "./preview";

const THUMBNAIL_WIDTH = 96;

export interface MediaPickerSelectionProps {
	/** Replaces an item's card. The remove button stays below it. */
	renderItem?: (media: DevulturMedia) => React.ReactNode;
	/** Level of the selection's heading (the cards' are one below). Default `3`. */
	headingLevel?: 2 | 3 | 4 | 5;
	/** Added to the region's `devultur-media-picker__selection` class. */
	className?: string;
}

/**
 * The picker's selection: a card per item (a thumbnail for images, the name, type, size and a download link) with
 * "Open preview" (an inline `<Preview>`) and remove, plus clear, and replace without `multiple`. Focused after an
 * upload and a removal, so a keyboard user lands on the result.
 */
export function MediaPickerSelection({ renderItem, headingLevel = 3, className }: MediaPickerSelectionProps) {
	const picker = useMediaPicker();
	const { labels, selected } = picker;
	const headingId = React.useId();
	const [previewedId, setPreviewedId] = React.useState<string | null>(null);
	const Heading = `h${headingLevel}` as const;
	const cardHeadingLevel = (headingLevel + 1) as 3 | 4 | 5 | 6;
	const regionClass = className ? `devultur-media-picker__selection ${className}` : "devultur-media-picker__selection";

	const handleOpen = (media: DevulturMedia) => setPreviewedId((current) => (current === media.id ? null : media.id));

	return (
		<section
			ref={picker.selectionRef as React.RefObject<HTMLElement>}
			tabIndex={-1}
			aria-labelledby={headingId}
			className={regionClass}
		>
			<Heading id={headingId}>{labels.selection}</Heading>
			{selected.length === 0 && <p data-part="empty">{labels.empty}</p>}
			{selected.length > 0 && (
				<ul data-part="items">
					{selected.map((media) => (
						<li key={media.id} data-kind={media.kind}>
							{renderItem ? (
								renderItem(media)
							) : (
								<AttachmentCard
									media={media}
									headingLevel={cardHeadingLevel}
									labels={picker.attachmentLabels}
									preview={media.kind === "image" ? <Thumbnail media={media} /> : undefined}
									onOpen={handleOpen}
								/>
							)}
							{previewedId === media.id && <Preview media={media} title={mediaName(media)} />}
							<button
								type="button"
								aria-label={labels.removeItem(mediaName(media))}
								onClick={() => picker.remove(media)}
							>
								{labels.remove}
							</button>
						</li>
					))}
				</ul>
			)}
			<SelectionActions />
		</section>
	);
}

function Thumbnail({ media }: { media: DevulturMedia }) {
	return (
		<Image
			media={media}
			width={THUMBNAIL_WIDTH}
			widths={[THUMBNAIL_WIDTH, THUMBNAIL_WIDTH * 2]}
			sizes={`${THUMBNAIL_WIDTH}px`}
			format="auto"
			alt=""
		/>
	);
}

function SelectionActions() {
	const picker = useMediaPicker();
	const { labels } = picker;
	if (picker.selected.length === 0) return null;
	return (
		<div data-part="actions">
			{!picker.multiple && (
				<button type="button" data-part="replace" onClick={picker.openFileDialog}>
					{labels.replace}
				</button>
			)}
			<button type="button" data-part="clear" onClick={picker.clear}>
				{labels.clear}
			</button>
		</div>
	);
}
