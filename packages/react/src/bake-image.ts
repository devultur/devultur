/** Crop rectangle in pixels of the **source** (what `react-easy-crop` returns as `croppedAreaPixels`). */
export interface CropRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type BakeOutputFormat = "webp" | "png" | "jpeg";

export interface BakeOptions {
	/** Output format. Default `webp` (preserves alpha if the source has it). */
	outputFormat?: BakeOutputFormat;
	/** Cap on output width (px). Retina is served by delivery (`<Image w>`), not baked in. Default 2048. */
	maxWidth?: number;
	/** Quality 0-1 for webp/jpeg. Default 0.82. */
	quality?: number;
}

/**
 * Output size derived from the crop, capping the width at `maxWidth` without distorting (preserves the crop's
 * aspect ratio). Pure → testable without a canvas.
 */
export function computeOutputSize(
	cropWidth: number,
	cropHeight: number,
	maxWidth: number,
): { width: number; height: number } {
	if (cropWidth <= 0 || cropHeight <= 0) return { width: 0, height: 0 };
	const scale = cropWidth > maxWidth ? maxWidth / cropWidth : 1;
	return { width: Math.round(cropWidth * scale), height: Math.round(cropHeight * scale) };
}

const EXTENSION: Record<BakeOutputFormat, string> = { webp: "webp", png: "png", jpeg: "jpg" };

/**
 * Bakes an image's crop into a new `File` (destructive bake). Applies the **EXIF orientation**
 * (`createImageBitmap({ imageOrientation: "from-image" })`), does NOT paint a background (→ **alpha preserved** when
 * the source has it; WebP supports native alpha), and caps the width at `maxWidth`. Browser-only.
 */
export async function bakeCroppedImage(file: File, crop: CropRect, options?: BakeOptions): Promise<File> {
	const format = options?.outputFormat ?? "webp";
	const maxWidth = options?.maxWidth ?? 2048;
	const quality = options?.quality ?? 0.82;

	const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
	try {
		const { width, height } = computeOutputSize(crop.width, crop.height, maxWidth);
		if (width === 0 || height === 0) throw new Error("Invalid crop region");

		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Canvas 2D context unavailable");

		// No background `fillRect` → the source's transparency survives the bake (WebP/PNG preserve it).
		ctx.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);

		const mime = `image/${format}`;
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality));
		if (!blob) throw new Error("Failed to encode the cropped image");

		const baseName = file.name.replace(/\.[^.]+$/, "");
		return new File([blob], `${baseName}.${EXTENSION[format]}`, { type: mime });
	} finally {
		bitmap.close();
	}
}
