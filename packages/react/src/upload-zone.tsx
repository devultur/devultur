"use client";

import React from "react";
import type { UploadZoneProps, UploadZoneRenderProps } from "./types";
import { useUpload } from "./use-upload";

/**
 * Drag-and-drop and click-to-select file upload zone with validation and progress.
 */
export function UploadZone({
	onUploadUrl,
	onComplete,
	onProgress,
	onError,
	accept,
	maxSize,
	disabled = false,
	children,
}: UploadZoneProps): React.ReactElement {
	const [isDragging, setIsDragging] = React.useState(false);
	const [file, setFile] = React.useState<File | null>(null);
	const inputRef = React.useRef<HTMLInputElement | null>(null);
	const dragCountRef = React.useRef(0);

	const { upload, progress, isUploading, error } = useUpload({ onUploadUrl, onComplete, onProgress, onError });

	const validateAndUpload = React.useCallback(
		(selectedFile: File) => {
			if (accept && !accept.some((type) => selectedFile.type.match(type))) {
				onError?.(new Error(`File type "${selectedFile.type}" is not accepted`));
				return;
			}

			if (maxSize && selectedFile.size > maxSize) {
				onError?.(new Error(`File size exceeds maximum of ${maxSize} bytes`));
				return;
			}

			setFile(selectedFile);
			upload(selectedFile);
		},
		[accept, maxSize, upload, onError],
	);

	const handleDragEnter = React.useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (disabled || isUploading) return;
			dragCountRef.current += 1;
			setIsDragging(true);
		},
		[disabled, isUploading],
	);

	const handleDragLeave = React.useCallback((event: React.DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		dragCountRef.current -= 1;
		if (dragCountRef.current <= 0) {
			dragCountRef.current = 0;
			setIsDragging(false);
		}
	}, []);

	const handleDragOver = React.useCallback((event: React.DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
	}, []);

	const handleDrop = React.useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();
			event.stopPropagation();
			dragCountRef.current = 0;
			setIsDragging(false);

			if (disabled || isUploading) return;

			const droppedFile = event.dataTransfer.files[0];
			if (!droppedFile) return;

			validateAndUpload(droppedFile);
		},
		[disabled, isUploading, validateAndUpload],
	);

	const handleChange = React.useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const selectedFile = event.target.files?.[0];
			if (!selectedFile) return;
			validateAndUpload(selectedFile);
		},
		[validateAndUpload],
	);

	const handleClick = React.useCallback(() => {
		if (disabled || isUploading) return;
		inputRef.current?.click();
	}, [disabled, isUploading]);

	const handleKeyDown = React.useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				handleClick();
			}
		},
		[handleClick],
	);

	const getRootProps = React.useCallback(
		(): Record<string, unknown> => ({
			onDragEnter: handleDragEnter,
			onDragLeave: handleDragLeave,
			onDragOver: handleDragOver,
			onDrop: handleDrop,
			onClick: handleClick,
			onKeyDown: handleKeyDown,
			role: "button",
			tabIndex: disabled ? -1 : 0,
			"aria-disabled": disabled,
			"data-dragging": isDragging || undefined,
			"data-uploading": isUploading || undefined,
			"data-error": error ? "" : undefined,
		}),
		[
			handleDragEnter,
			handleDragLeave,
			handleDragOver,
			handleDrop,
			handleClick,
			handleKeyDown,
			disabled,
			isDragging,
			isUploading,
			error,
		],
	);

	const getInputProps = React.useCallback(
		(): Record<string, unknown> => ({
			ref: inputRef,
			type: "file",
			accept: accept?.join(","),
			onChange: handleChange,
			style: { display: "none" },
			tabIndex: -1,
		}),
		[accept, handleChange],
	);

	const renderProps: UploadZoneRenderProps = {
		getRootProps,
		getInputProps,
		isDragging,
		isUploading,
		progress,
		file,
		error,
	};

	if (typeof children === "function") {
		return children(renderProps) as React.ReactElement;
	}

	const { ref: _inputRef, ...inputPropsWithoutRef } = getInputProps();

	return (
		<div {...getRootProps()}>
			<input {...inputPropsWithoutRef} ref={inputRef} />
			{children ?? (
				<div>
					<p>{isDragging ? "Drop file here" : "Drag & drop or click to upload"}</p>
					{isUploading && <p>{progress}%</p>}
					{error && <p>{error.message}</p>}
				</div>
			)}
		</div>
	);
}
