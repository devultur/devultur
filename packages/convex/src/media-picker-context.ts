"use client";

import React from "react";
import type { DevulturMedia } from "@devultur/core";
import type { AttachmentLabels } from "./attachment-labels";
import type { MediaLibraryLabels } from "./media-library-labels";
import type { MediaPickerLabels } from "./media-picker-labels";
import type { MediaRecord } from "./types";
import type { MediaPickerUploads } from "./use-media-picker-uploads";

/** What every part of a `<MediaPicker>` (and its render prop, and `useMediaPicker()`) gets. */
export interface MediaPickerState extends MediaPickerUploads {
	/** The selection, in order (one item at most without `multiple`). */
	selected: readonly DevulturMedia[];
	multiple: boolean;
	/** The upload `accept`: the picker's own, else the one its `type` implies. */
	accept: readonly string[] | undefined;
	/** The library's type filter: the picker's `type`, else the one `accept` implies. */
	libraryType: MediaRecord["type"] | undefined;
	labels: MediaPickerLabels;
	libraryLabels: Partial<MediaLibraryLabels> | undefined;
	attachmentLabels: Partial<AttachmentLabels> | undefined;
	/** Selects a media (replaces the selection without `multiple`). */
	select: (media: DevulturMedia) => void;
	/** Selects a media, or removes it when it's selected already (with `multiple`). */
	toggle: (media: DevulturMedia) => void;
	remove: (media: DevulturMedia) => void;
	clear: () => void;
	/** Opens the browser's file chooser. */
	openFileDialog: () => void;
	/** Says `message` in the picker's polite live region. */
	announce: (message: string) => void;
	/** The selection's region, focused after an upload and a removal (the `<MediaPicker.Selection>` sets it). */
	selectionRef: React.RefObject<HTMLElement | null>;
}

export const MediaPickerContext = React.createContext<MediaPickerState | null>(null);

/** The state of the nearest `<MediaPicker>`, to build a part of your own. */
export function useMediaPicker(): MediaPickerState {
	const picker = React.use(MediaPickerContext);
	if (!picker) throw new Error("useMediaPicker must be used within <MediaPicker>");
	return picker;
}

/** A media's display name: its title, else its filename, else its id. */
export const mediaName = (media: DevulturMedia) => media.title ?? media.filename ?? media.id;
