// An image's intrinsic size, read from the plaintext's header bytes on a single PUT (nothing is decoded) and kept in
// the object's metadata, so GET/HEAD return it (`x-devultur-image-width` / `-height`) and a media record can store it
// without trusting the uploader. A multipart upload's metadata is fixed before its bytes arrive: it has no size.
import { IMAGE_HEIGHT_HEADER, IMAGE_WIDTH_HEADER } from "@devultur/core";
import { readImageDimensions } from "../image/dimensions";
import { ObjectMeta } from "./upload-integrity";

/** Larger than any real image side; a header claiming more is corrupt or hostile. */
const MAX_IMAGE_SIDE = 100_000;

function isImageSide(value: number): boolean {
	return Number.isInteger(value) && value > 0 && value <= MAX_IMAGE_SIDE;
}

/** The size metadata for an image body (`{}` when it isn't an image or its header can't be read). Pure. */
export function imageSizeMetadata(contentType: string, body: ArrayBuffer): Record<string, string> {
	if (!contentType.startsWith("image/")) return {};
	const dimensions = readImageDimensions(new Uint8Array(body), contentType);
	if (!dimensions || !isImageSide(dimensions.width) || !isImageSide(dimensions.height)) return {};
	return { [ObjectMeta.IMAGE_WIDTH]: String(dimensions.width), [ObjectMeta.IMAGE_HEIGHT]: String(dimensions.height) };
}

/** `x-devultur-image-width` / `-height` from the object's metadata, when it has them. */
export function applyImageSizeHeaders(headers: Headers, customMetadata: Record<string, string> | undefined): void {
	const width = customMetadata?.[ObjectMeta.IMAGE_WIDTH];
	const height = customMetadata?.[ObjectMeta.IMAGE_HEIGHT];
	if (!width || !height) return;
	headers.set(IMAGE_WIDTH_HEADER, width);
	headers.set(IMAGE_HEIGHT_HEADER, height);
}
