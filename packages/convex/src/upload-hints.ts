// What the browser learns about an uploaded file and records with it: shared by `<DevulturProvider>`'s `upload()` and
// `useMediaUpload`.

// Records the upload in the component. Best-effort: the bytes are stored, and the component's scheduled check records
// an upload nobody confirmed, so a failure here never fails the upload.
export async function confirmUploadBestEffort(
	confirmUpload: (args: Record<string, unknown>) => Promise<unknown>,
	key: string,
	file: File,
	hints: { width?: number; height?: number; pageCount?: number },
): Promise<void> {
	try {
		await confirmUpload({ key, filename: file.name, ...hints });
	} catch (error) {
		console.warn("Devultur: could not record the upload; it is recorded later", error);
	}
}

// Captures an image's intrinsic dimensions in the browser (for <img> with no CLS). No-op outside the
// browser or for non-images → empty object. Fails silently: dimensions are best-effort.
export async function readImageDimensions(file: File): Promise<{ width?: number; height?: number }> {
	if (typeof createImageBitmap !== "function" || !file.type.startsWith("image/")) return {};
	try {
		const bitmap = await createImageBitmap(file);
		const dimensions = { width: bitmap.width, height: bitmap.height };
		bitmap.close();
		return dimensions;
	} catch {
		return {};
	}
}
