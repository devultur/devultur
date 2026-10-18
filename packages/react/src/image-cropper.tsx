"use client";

import React from "react";
import Cropper, { type Area, type Point } from "react-easy-crop";
import { type BakeOutputFormat, bakeCroppedImage } from "./bake-image";

export interface ImageCropperRenderProps {
	zoom: number;
	setZoom: (zoom: number) => void;
	/** Bakes the current crop and calls `onCrop`. No-op while `isBaking`. */
	confirm: () => void;
	isBaking: boolean;
}

export interface ImageCropperProps {
	/** Original file to crop. */
	file: File;
	/** Aspect ratio of the crop (width/height), e.g. `16/9`. */
	aspectRatio: number;
	outputFormat?: BakeOutputFormat;
	maxWidth?: number;
	quality?: number;
	/** Minimum crop width in source px → if the crop ends up smaller, it's rejected (anti-upscaling). */
	minSourceWidth?: number;
	/** Receives the baked `File` ready to upload. */
	onCrop: (file: File) => void;
	onReject?: (reason: "too_small") => void;
	/**
	 * Class for the **cropper's box** — it only needs a **height** (react-easy-crop fills it absolutely). The
	 * component sets `position: relative`, and the controls (`children`) render OUTSIDE the box
	 * so the cropper doesn't cover them.
	 */
	className?: string;
	/** Custom controls (zoom/confirm). Without this, the cropper shows with no confirm button. */
	children?: (api: ImageCropperRenderProps) => React.ReactNode;
}

/**
 * Headless wrapper around `react-easy-crop`: shows the crop box locked to `aspectRatio` and, on
 * confirm, **bakes** the crop into a `File` (via {@link bakeCroppedImage}) delivered through `onCrop`.
 * Leaves encode/orientation/alpha resolved; the consumer provides the controls UI and styling.
 */
export function ImageCropper({
	file,
	aspectRatio,
	outputFormat,
	maxWidth,
	quality,
	minSourceWidth,
	onCrop,
	onReject,
	className,
	children,
}: ImageCropperProps) {
	const [imageUrl] = React.useState(() => URL.createObjectURL(file));
	const [crop, setCrop] = React.useState<Point>({ x: 0, y: 0 });
	const [zoom, setZoom] = React.useState(1);
	const [pixels, setPixels] = React.useState<Area | null>(null);
	const [isBaking, setIsBaking] = React.useState(false);

	React.useEffect(() => () => URL.revokeObjectURL(imageUrl), [imageUrl]);

	const confirm = React.useCallback(async () => {
		if (!pixels || isBaking) return;
		if (minSourceWidth && pixels.width < minSourceWidth) {
			onReject?.("too_small");
			return;
		}
		setIsBaking(true);
		try {
			const baked = await bakeCroppedImage(file, pixels, { outputFormat, maxWidth, quality });
			onCrop(baked);
		} finally {
			setIsBaking(false);
		}
	}, [pixels, isBaking, minSourceWidth, file, outputFormat, maxWidth, quality, onCrop, onReject]);

	return (
		<div>
			{/* The Cropper positions itself ABSOLUTE filling its container → it goes in its own box (relative + height).
			    The controls go OUTSIDE that box, otherwise the cropper would cover them (they wouldn't be clickable). */}
			<div className={className} style={{ position: "relative" }}>
				<Cropper
					image={imageUrl}
					crop={crop}
					zoom={zoom}
					aspect={aspectRatio}
					onCropChange={setCrop}
					onZoomChange={setZoom}
					onCropComplete={(_area, areaPixels) => setPixels(areaPixels)}
				/>
			</div>
			{children?.({ zoom, setZoom, confirm, isBaking })}
		</div>
	);
}
