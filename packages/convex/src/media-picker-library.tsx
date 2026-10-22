"use client";

import React from "react";
import { MediaLibrary, type MediaLibraryProps } from "./media-library";
import { recordMatchesAccept } from "./media-picker-accept";
import { useMediaPicker } from "./media-picker-context";
import type { MediaRecord } from "./types";

/** What `<MediaPicker.Library>` passes through to `<MediaLibrary>`; the picker sets the rest. */
export type MediaPickerLibraryProps = Pick<
	MediaLibraryProps,
	"renderItem" | "pageSize" | "pdfThumbnails" | "className" | "classNames"
>;

/**
 * The picker's `<MediaLibrary>`: shows the selection as selected, picks (and, with `multiple`, unpicks) an item on
 * click, Enter or Space, and lists only what `accept` lets through.
 */
export function MediaPickerLibrary(props: MediaPickerLibraryProps) {
	const picker = useMediaPicker();
	const { accept, toggle } = picker;
	const selectedKeys = picker.selected.map((media) => media.id);
	const filter = React.useMemo(
		() => (accept ? (record: MediaRecord) => recordMatchesAccept(record, accept) : undefined),
		[accept],
	);

	return (
		<MediaLibrary
			{...props}
			type={picker.libraryType}
			labels={picker.libraryLabels}
			selectedKeys={selectedKeys}
			multiple={picker.multiple}
			filter={filter}
			onSelect={(_record, media) => {
				if (media) toggle(media);
			}}
		/>
	);
}
