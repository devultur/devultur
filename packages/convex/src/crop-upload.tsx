"use client";

import React from "react";
import type { DevulturMedia, Visibility } from "@devultur/core";
import { type BakeOutputFormat, ImageCropper, type MediaUploadState } from "@devultur/react";
import { useMediaUpload } from "./use-media-upload";

export interface CropUploadRenderProps {
	/** The state machine of the full cycle (idle → uploading → ready / failed). */
	state: MediaUploadState;
	/** Opens the file picker. */
	pickFile: () => void;
	/** Selected file waiting to be cropped (`null` if none). */
	pendingFile: File | null;
	/** Cancels the in-progress upload. */
	cancel: () => void;
	/** Returns to idle and clears state (including discarding the pending file). */
	reset: () => void;
}

/** Text of the crop controls; pass your own to localize them. */
export interface CropUploadLabels {
	zoom: string;
	confirm: string;
	processing: string;
	cancel: string;
}

const DEFAULT_LABELS: CropUploadLabels = {
	zoom: "Zoom",
	confirm: "Crop and upload",
	processing: "Processing…",
	cancel: "Cancel",
};

export interface CropUploadProps {
	/** Crop aspect ratio (width/height), e.g. `16/9`. */
	aspectRatio: number;
	visibility?: Visibility;
	outputFormat?: BakeOutputFormat;
	maxWidth?: number;
	minSourceWidth?: number;
	/** Deletes this old asset after a successful upload. */
	replaces?: DevulturMedia | null;
	/** Fires with the uploaded `DevulturMedia` (persistence point). */
	onComplete?: (media: DevulturMedia) => void;
	onReject?: (reason: "too_small") => void;
	/** Accepted types in the file picker. Default `["image/*"]`. */
	accept?: string[];
	/** Class for the cropper's box — only needs a **height** (`position: relative` is automatic). */
	cropperClassName?: string;
	/** Overrides any of the control labels (English by default). */
	labels?: Partial<CropUploadLabels>;
	/** External UI (trigger + state). Receives `pickFile`/`state`. Without this there's no way to start. */
	children?: (api: CropUploadRenderProps) => React.ReactNode;
}

/**
 * Upload with aspect-ratio crop: file picker → `<ImageCropper>` (crop + bake to WebP) →
 * `useMediaUpload` (uploads the cropped result, returns `DevulturMedia`). Batteries-included for the crop
 * phase (zoom + confirm); the trigger and state rendering are left to the consumer via `children`.
 */
export function CropUpload({
	aspectRatio,
	visibility,
	outputFormat,
	maxWidth,
	minSourceWidth,
	replaces,
	onComplete,
	onReject,
	accept = ["image/*"],
	cropperClassName,
	labels,
	children,
}: CropUploadProps) {
	const text = { ...DEFAULT_LABELS, ...labels };
	const [pendingFile, setPendingFile] = React.useState<File | null>(null);
	const inputRef = React.useRef<HTMLInputElement>(null);
	const { upload, state, cancel, reset } = useMediaUpload({ visibility, replaces, onComplete });

	const pickFile = React.useCallback(() => inputRef.current?.click(), []);
	const handleCrop = React.useCallback(
		(baked: File) => {
			setPendingFile(null);
			upload(baked);
		},
		[upload],
	);
	const resetAll = React.useCallback(() => {
		setPendingFile(null);
		reset();
	}, [reset]);

	return (
		<div>
			<input
				ref={inputRef}
				type="file"
				accept={accept.join(",")}
				hidden
				onChange={(event) => {
					const file = event.target.files?.[0];
					if (file) setPendingFile(file);
					event.target.value = "";
				}}
			/>

			{pendingFile && (
				<ImageCropper
					file={pendingFile}
					aspectRatio={aspectRatio}
					outputFormat={outputFormat}
					maxWidth={maxWidth}
					minSourceWidth={minSourceWidth}
					onCrop={handleCrop}
					onReject={onReject}
					className={cropperClassName}
				>
					{({ zoom, setZoom, confirm, isBaking }) => (
						<div className="dv-crop-controls">
							<input
								type="range"
								min={1}
								max={3}
								step={0.01}
								value={zoom}
								onChange={(event) => setZoom(Number(event.target.value))}
								aria-label={text.zoom}
							/>
							<button type="button" onClick={confirm} disabled={isBaking}>
								{isBaking ? text.processing : text.confirm}
							</button>
							<button type="button" onClick={() => setPendingFile(null)}>
								{text.cancel}
							</button>
						</div>
					)}
				</ImageCropper>
			)}

			{children?.({ state, pickFile, pendingFile, cancel, reset: resetAll })}
		</div>
	);
}
