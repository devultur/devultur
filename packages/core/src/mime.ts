export const VIDEO_MIMES = ["video/mp4", "video/quicktime", "video/webm", "video/x-msvideo", "video/x-matroska"];

export const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif", "image/svg+xml"];

export const FILE_MIMES = [
	"application/pdf",
	"application/zip",
	"application/gzip",
	"application/x-tar",
	"application/x-7z-compressed",
	"application/msword",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.ms-powerpoint",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"text/plain",
	"text/csv",
];

export function isValidMime(mime: string, accepted: string[]): boolean {
	const normalizedMime = mime.toLowerCase().trim();

	return accepted.some((pattern) => {
		const normalizedPattern = pattern.toLowerCase().trim();

		if (normalizedPattern === normalizedMime) return true;

		if (normalizedPattern.endsWith("/*")) {
			const patternPrefix = normalizedPattern.slice(0, -1);
			return normalizedMime.startsWith(patternPrefix);
		}

		if (normalizedPattern.includes("*")) {
			const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
			return new RegExp(`^${escaped}$`).test(normalizedMime);
		}

		return false;
	});
}
