// Pure filename / Content-Disposition helpers. They live in core so BOTH the worker (self-host)
// AND the router's pre-signed path (direct storage) share the same normalization — previously only the
// worker sanitized, and the router let through names with spaces/accents that broke the key/URL.

// Normalizes the filename for use as a storage KEY (R2 path / URL-safe). The ORIGINAL name is
// kept separately (media record + Content-Disposition) for display/download.
// "Mi Video #1.mp4" → "Mi-Video-1.mp4" · "Café Ñandú.MP4" → "Cafe-Nandu.mp4"
export function sanitizeFilename(filename: string): string {
	const lastDot = filename.lastIndexOf(".");
	const hasExt = lastDot > 0;
	const name = hasExt ? filename.slice(0, lastDot) : filename;
	const ext = hasExt ? filename.slice(lastDot + 1) : "";

	const safeName =
		name
			.normalize("NFKD") // splits diacritics (é → e + ´)
			.replace(/[̀-ͯ]/g, "") // removes them
			.replace(/[^a-zA-Z0-9._-]/g, "-") // everything else → dash
			.replace(/-+/g, "-")
			.replace(/^[-.]+|[-.]+$/g, "") || "file";
	const safeExt = ext
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-zA-Z0-9]/g, "")
		.toLowerCase();

	return safeExt ? `${safeName}.${safeExt}` : safeName;
}

// Content-Disposition that preserves the original name (RFC 5987 for non-ASCII: accents, emojis).
// "inline" doesn't force a download (safe for showing images / playback); "attachment" does force one
// (the media route's `?download`). Both give the original name when saved.
function contentDisposition(type: "inline" | "attachment", filename: string): string {
	const ascii = filename.replace(/[^ -~]/g, "_").replace(/["\\]/g, "_");
	return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function contentDispositionInline(filename: string): string {
	return contentDisposition("inline", filename);
}

export function contentDispositionAttachment(filename: string): string {
	return contentDisposition("attachment", filename);
}
