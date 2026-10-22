import { describeDevulturError } from "./error-labels";

/**
 * Every string `<MediaPicker>` shows or announces (the library's and the cards' have their own: `libraryLabels`,
 * `attachmentLabels`). Pass any subset as `labels`; the rest stay English. Spanish: `mediaPickerLabels` from
 * `@devultur/convex/locales/es`.
 */
export interface MediaPickerLabels {
	/** The upload button: one file, or several with `multiple`. */
	upload: (multiple: boolean) => string;
	/** Next to the upload button, for dragging files onto it. */
	dropHint: (multiple: boolean) => string;
	/** Accessible name of the list of uploads in progress. */
	uploads: string;
	/** Accessible name of a file's progress bar. */
	progress: (filename: string) => string;
	/** A file's progress as text. */
	percent: (percent: number) => string;
	/** Announced when a file starts uploading. */
	uploading: (filename: string) => string;
	/** Announced when a file has uploaded (and is selected). */
	uploaded: (filename: string) => string;
	cancel: string;
	/** Accessible name of a file's cancel button. */
	cancelUpload: (filename: string) => string;
	/** Announced when an upload is cancelled. */
	cancelled: (filename: string) => string;
	/** A file `accept` turns away, before it uploads. */
	notAccepted: (filename: string) => string;
	/** Why an upload failed. Default: the Devultur error's message, if it is one. */
	uploadError: (error: unknown) => string;
	retry: string;
	dismiss: string;
	/** Heading and accessible name of the selection. */
	selection: string;
	/** Nothing is selected. */
	empty: string;
	remove: string;
	/** Accessible name of an item's remove button. */
	removeItem: (name: string) => string;
	/** Removes every selected item. */
	clear: string;
	/** Picks another file in place of the selected one (single selection). */
	replace: string;
	/** Announced when an item is selected. */
	selected: (name: string) => string;
	/** Announced when an item is removed from the selection. */
	removed: (name: string) => string;
	/** Announced when the selection is cleared. */
	cleared: string;
}

export const defaultMediaPickerLabels: MediaPickerLabels = {
	upload: (multiple) => (multiple ? "Upload files" : "Upload a file"),
	dropHint: (multiple) => (multiple ? "or drop files here" : "or drop a file here"),
	uploads: "Uploads",
	progress: (filename) => `Uploading ${filename}`,
	percent: (percent) => `${percent}%`,
	uploading: (filename) => `Uploading ${filename}.`,
	uploaded: (filename) => `${filename} uploaded and selected.`,
	cancel: "Cancel",
	cancelUpload: (filename) => `Cancel uploading ${filename}`,
	cancelled: (filename) => `Upload of ${filename} cancelled.`,
	notAccepted: (filename) => `${filename} isn't a file type you can pick here.`,
	uploadError: (error) => describeDevulturError(error) ?? "The upload failed. Try again.",
	retry: "Try again",
	dismiss: "Dismiss",
	selection: "Selected media",
	empty: "Nothing selected.",
	remove: "Remove",
	removeItem: (name) => `Remove ${name}`,
	clear: "Clear",
	replace: "Replace",
	selected: (name) => `${name} selected.`,
	removed: (name) => `${name} removed.`,
	cleared: "Selection cleared.",
};

/** The defaults with `labels` over them; a key set to `undefined` keeps the default. */
export function mergeMediaPickerLabels(labels: Partial<MediaPickerLabels> | undefined): MediaPickerLabels {
	const merged: Record<string, unknown> = { ...defaultMediaPickerLabels };
	for (const [key, value] of Object.entries(labels ?? {})) {
		if (value !== undefined) merged[key] = value;
	}
	return merged as unknown as MediaPickerLabels;
}
