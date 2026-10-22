"use client";

import React from "react";
import { useMediaPicker } from "./media-picker-context";
import type { MediaPickerUpload as Upload } from "./use-media-picker-uploads";

export interface MediaPickerUploadProps {
	/** Added to the drop zone's `devultur-media-picker__upload` class. */
	className?: string;
}

/**
 * The picker's upload area: a button that opens the file chooser, a drop target for files, and each upload's
 * progress with a cancel button (or its error, with retry and dismiss).
 */
export function MediaPickerUpload({ className }: MediaPickerUploadProps) {
	const picker = useMediaPicker();
	const { labels, multiple } = picker;
	const [isDragging, setIsDragging] = React.useState(false);

	const handleDragOver = (event: React.DragEvent) => {
		event.preventDefault();
		setIsDragging(true);
	};

	const handleDragLeave = (event: React.DragEvent) => {
		if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
		setIsDragging(false);
	};

	const handleDrop = (event: React.DragEvent) => {
		event.preventDefault();
		setIsDragging(false);
		const files = event.dataTransfer.files;
		if (files.length > 0) picker.start(files);
	};

	const zoneClass = className ? `devultur-media-picker__upload ${className}` : "devultur-media-picker__upload";
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: dropping is a pointer shortcut; the button is the keyboard path.
		<div
			className={zoneClass}
			data-dragging={isDragging || undefined}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			<button type="button" data-part="upload" onClick={picker.openFileDialog}>
				{labels.upload(multiple)}
			</button>
			<span data-part="drop-hint">{labels.dropHint(multiple)}</span>
			{picker.uploads.length > 0 && (
				<ul aria-label={labels.uploads} data-part="uploads">
					{picker.uploads.map((upload) => (
						<UploadRow key={upload.id} upload={upload} />
					))}
				</ul>
			)}
		</div>
	);
}

function UploadRow({ upload }: { upload: Upload }) {
	const picker = useMediaPicker();
	const { labels } = picker;
	const filename = upload.file.name;

	if (upload.status === "failed") {
		return (
			<li data-status="failed">
				<span data-part="filename">{filename}</span>
				<span role="alert" data-part="error">
					{upload.error}
				</span>
				{upload.canRetry && (
					<button type="button" onClick={() => picker.retry(upload.id)}>
						{labels.retry}
					</button>
				)}
				<button type="button" onClick={() => picker.dismiss(upload.id)}>
					{labels.dismiss}
				</button>
			</li>
		);
	}

	const percent = Math.round(upload.fraction * 100);
	return (
		<li data-status="uploading">
			<span data-part="filename">{filename}</span>
			<progress max={100} value={percent} aria-label={labels.progress(filename)} />
			<span data-part="percent">{labels.percent(percent)}</span>
			<button type="button" aria-label={labels.cancelUpload(filename)} onClick={() => picker.cancel(upload.id)}>
				{labels.cancel}
			</button>
		</li>
	);
}
