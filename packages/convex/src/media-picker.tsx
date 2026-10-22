"use client";

import React from "react";
import type { DevulturMedia } from "@devultur/core";
import type { AttachmentLabels } from "./attachment-labels";
import type { MediaLibraryLabels } from "./media-library-labels";
import { mediaTypeOfAccept, uploadAcceptOf } from "./media-picker-accept";
import { MediaPickerContext, type MediaPickerState, mediaName } from "./media-picker-context";
import { type MediaPickerLabels, mergeMediaPickerLabels } from "./media-picker-labels";
import { MediaPickerLibrary } from "./media-picker-library";
import { MediaPickerSelection } from "./media-picker-selection";
import { MediaPickerUpload } from "./media-picker-upload";
import { usePdfPageCounter } from "./pdf-context";
import { VISUALLY_HIDDEN } from "./pdf-preview";
import type { MediaRecord } from "./types";
import { useMediaPickerUploads } from "./use-media-picker-uploads";

interface SingleValueProps {
	multiple?: false;
	/** The selected media, controlled. Omitted → the picker keeps its own. */
	value?: DevulturMedia | null;
	/** Called with the new selection: on an upload, a pick from the library, a removal or a clear. */
	onChange: (value: DevulturMedia | null) => void;
}

interface MultipleValueProps {
	/** Several media can be selected; `value` and `onChange` take arrays. */
	multiple: true;
	value?: readonly DevulturMedia[];
	onChange: (value: DevulturMedia[]) => void;
}

interface CommonProps {
	/**
	 * File types to pick, as an `<input accept>` takes them (`image/*`, `application/pdf`, `.pdf`). Filters the files to
	 * upload and the library's records, and sets the library's type filter when they're all of one type.
	 */
	accept?: readonly string[];
	/** Only this kind of media in the library; without `accept`, also what can be uploaded (`image/*`, `video/*`). */
	type?: MediaRecord["type"];
	/** Overrides any of the picker's strings; the rest stay English. */
	labels?: Partial<MediaPickerLabels>;
	/** Labels for the library (`<MediaPicker.Library>`). */
	libraryLabels?: Partial<MediaLibraryLabels>;
	/** Labels for the selection's cards (`<AttachmentCard>`). */
	attachmentLabels?: Partial<AttachmentLabels>;
	/** Added to the root's `devultur-media-picker` class. */
	className?: string;
	/**
	 * The picker's layout: the parts (`<MediaPicker.Upload>`, `.Library`, `.Selection`) in any order and markup, or a
	 * function of the picker's state. Default: the upload, the library and the selection, in that order.
	 */
	children?: React.ReactNode | ((picker: MediaPickerState) => React.ReactNode);
}

export type MediaPickerProps = CommonProps & (SingleValueProps | MultipleValueProps);

const EMPTY: readonly DevulturMedia[] = [];

function selectionOf(props: MediaPickerProps): readonly DevulturMedia[] | undefined {
	if (props.value === undefined) return undefined;
	if (props.multiple) return props.value;
	return props.value ? [props.value] : EMPTY;
}

function emit(props: MediaPickerProps, next: DevulturMedia[]) {
	if (props.multiple) {
		props.onChange(next);
		return;
	}
	props.onChange(next[0] ?? null);
}

const isSame = (a: DevulturMedia, b: DevulturMedia) => a.id === b.id;

/**
 * Lets an editor pick media: upload new files (progress, cancel, retry), browse and search the library, and review
 * the selection. Returns `DevulturMedia` references through `onChange`; a new upload is selected. It renders inline,
 * with no dialog of its own: put it in yours. Needs `createUploadUrl`, `listMediaPage` and `searchMedia` in
 * `<DevulturProvider api>` (and `confirmUpload` to record uploads). Under a `PdfPreviewProvider` with pdf.js, a PDF's
 * page count is read before it uploads.
 *
 * @example
 * <MediaPicker accept={["image/*"]} value={cover} onChange={setCover} />
 */
export function MediaPicker(props: MediaPickerProps) {
	const isMultiple = props.multiple ?? false;
	const labels = React.useMemo(() => mergeMediaPickerLabels(props.labels), [props.labels]);
	const accept = uploadAcceptOf(props.accept, props.type);
	const libraryType = props.type ?? mediaTypeOfAccept(props.accept);
	const countPdfPages = usePdfPageCounter();
	const [announcement, setAnnouncement] = React.useState("");
	const inputRef = React.useRef<HTMLInputElement | null>(null);
	const selectionRef = React.useRef<HTMLElement | null>(null);

	const [ownSelection, setOwnSelection] = React.useState<readonly DevulturMedia[]>(EMPTY);
	const controlledSelection = selectionOf(props);
	const selected = controlledSelection ?? ownSelection;
	// The latest selection, so uploads finishing between renders add to each other.
	const selectedRef = React.useRef(selected);
	selectedRef.current = selected;
	const propsRef = React.useRef(props);
	propsRef.current = props;
	const isControlled = controlledSelection !== undefined;

	const commit = React.useCallback(
		(next: DevulturMedia[]) => {
			selectedRef.current = next;
			if (!isControlled) setOwnSelection(next);
			emit(propsRef.current, next);
		},
		[isControlled],
	);

	const announce = React.useCallback((message: string) => setAnnouncement(message), []);

	const select = React.useCallback(
		(media: DevulturMedia) => {
			const current = selectedRef.current.filter((item) => !isSame(item, media));
			commit(isMultiple ? [...current, media] : [media]);
		},
		[commit, isMultiple],
	);

	const remove = React.useCallback(
		(media: DevulturMedia) => {
			commit(selectedRef.current.filter((item) => !isSame(item, media)));
			announce(labels.removed(mediaName(media)));
			selectionRef.current?.focus();
		},
		[commit, announce, labels],
	);

	const toggle = React.useCallback(
		(media: DevulturMedia) => {
			const isSelected = selectedRef.current.some((item) => isSame(item, media));
			if (isMultiple && isSelected) {
				remove(media);
				return;
			}
			select(media);
			announce(labels.selected(mediaName(media)));
		},
		[isMultiple, remove, select, announce, labels],
	);

	const clear = React.useCallback(() => {
		commit([]);
		announce(labels.cleared);
		selectionRef.current?.focus();
	}, [commit, announce, labels]);

	const handleUploaded = React.useCallback(
		(media: DevulturMedia) => {
			select(media);
			selectionRef.current?.focus();
		},
		[select],
	);

	const uploads = useMediaPickerUploads({
		accept,
		multiple: isMultiple,
		labels,
		countPdfPages,
		onUploaded: handleUploaded,
		announce,
	});

	const handleFileInput = (event: React.ChangeEvent<HTMLInputElement>) => {
		const files = event.target.files;
		if (files && files.length > 0) uploads.start(files);
		// The same file can be chosen again (after a cancel, say).
		event.target.value = "";
	};

	const picker: MediaPickerState = {
		...uploads,
		selected,
		multiple: isMultiple,
		accept,
		libraryType,
		labels,
		libraryLabels: props.libraryLabels,
		attachmentLabels: props.attachmentLabels,
		select,
		toggle,
		remove,
		clear,
		openFileDialog: () => inputRef.current?.click(),
		announce,
		selectionRef,
	};

	const content =
		typeof props.children === "function"
			? props.children(picker)
			: (props.children ?? (
					<>
						<MediaPickerUpload />
						<MediaPickerLibrary />
						<MediaPickerSelection />
					</>
				));

	const rootClass = props.className ? `devultur-media-picker ${props.className}` : "devultur-media-picker";
	return (
		<MediaPickerContext value={picker}>
			<div className={rootClass}>
				<input
					ref={inputRef}
					type="file"
					accept={accept?.join(",")}
					multiple={isMultiple}
					tabIndex={-1}
					aria-hidden
					style={{ display: "none" }}
					onChange={handleFileInput}
					data-part="input"
				/>
				{content}
				<div role="status" aria-live="polite" style={VISUALLY_HIDDEN}>
					{announcement}
				</div>
			</div>
		</MediaPickerContext>
	);
}

MediaPicker.Upload = MediaPickerUpload;
MediaPicker.Library = MediaPickerLibrary;
MediaPicker.Selection = MediaPickerSelection;
