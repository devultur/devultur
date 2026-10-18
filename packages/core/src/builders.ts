import { FILE_MIMES, IMAGE_MIMES, VIDEO_MIMES } from "./mime";
import { parseSize } from "./size";
import type { FileBuilderConfig, ImageBuilderConfig, VideoBuilderConfig } from "./types";

const MIME_PATTERN = /^[a-z]+\/[a-z0-9.*+-]+$/i;

function validateAccept(accept: string[], label: string): void {
	for (const mimeType of accept) {
		if (mimeType.includes("*")) continue;
		if (!MIME_PATTERN.test(mimeType)) {
			throw new Error(`Invalid ${label} MIME type format: "${mimeType}"`);
		}
	}
}

export function video(config: VideoBuilderConfig): VideoBuilderConfig {
	parseSize(config.maxSize);

	if (config.accept) {
		validateAccept(config.accept, "video");
	}

	return {
		...config,
		accept: config.accept ?? VIDEO_MIMES,
	};
}

export function image(config: ImageBuilderConfig): ImageBuilderConfig {
	parseSize(config.maxSize);

	if (config.accept) {
		validateAccept(config.accept, "image");
	}

	return {
		...config,
		accept: config.accept ?? IMAGE_MIMES,
	};
}

export function file(config: FileBuilderConfig): FileBuilderConfig {
	parseSize(config.maxSize);

	if (config.accept) {
		validateAccept(config.accept, "file");
	}

	return {
		...config,
		accept: config.accept ?? FILE_MIMES,
	};
}
