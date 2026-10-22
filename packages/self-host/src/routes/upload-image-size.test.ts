import { IMAGE_HEIGHT_HEADER, IMAGE_WIDTH_HEADER } from "@devultur/core";
import { describe, expect, it } from "vitest";
import { applyImageSizeHeaders, imageSizeMetadata } from "./upload-image-size";
import { allowedUploadMetadata } from "./upload-integrity";

function gif(width: number, height: number): ArrayBuffer {
	const bytes = new Uint8Array([
		0x47,
		0x49,
		0x46,
		0x38,
		0x39,
		0x61,
		width & 0xff,
		width >> 8,
		height & 0xff,
		height >> 8,
	]);
	return bytes.buffer;
}

describe("imageSizeMetadata", () => {
	it("records an image's size from its header bytes", () => {
		expect(imageSizeMetadata("image/gif", gif(320, 240))).toEqual({ imageWidth: "320", imageHeight: "240" });
	});

	it("records nothing for other types, unreadable headers or a zero side", () => {
		expect(imageSizeMetadata("application/pdf", gif(320, 240))).toEqual({});
		expect(imageSizeMetadata("image/png", gif(320, 240))).toEqual({});
		expect(imageSizeMetadata("image/gif", gif(0, 240))).toEqual({});
	});
});

describe("applyImageSizeHeaders", () => {
	it("returns the recorded size on GET/HEAD", () => {
		const headers = new Headers();
		applyImageSizeHeaders(headers, { imageWidth: "320", imageHeight: "240" });
		expect(headers.get(IMAGE_WIDTH_HEADER)).toBe("320");
		expect(headers.get(IMAGE_HEIGHT_HEADER)).toBe("240");
	});

	it("sets nothing without both sides", () => {
		const headers = new Headers();
		applyImageSizeHeaders(headers, { imageWidth: "320" });
		applyImageSizeHeaders(headers, undefined);
		expect(headers.has(IMAGE_WIDTH_HEADER)).toBe(false);
	});
});

describe("the size metadata belongs to the Worker", () => {
	it("is stripped from a plugin's upload metadata", () => {
		expect(allowedUploadMetadata({ imageWidth: "1", ImageHeight: "1", campaign: "spring" })).toEqual({
			campaign: "spring",
		});
	});
});
