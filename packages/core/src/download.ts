export interface DownloadUrlOptions {
	/** Name the file is saved as. Without this, the upload's original name is used. */
	filename?: string;
}

/**
 * Converts a media URL (from `getMediaUrl` or an upload result) into one that **downloads**
 * instead of rendering inline. The worker serves it with `Content-Disposition: attachment`, so a
 * plain `<a href download>` works even cross-origin and streams large files (doesn't load the
 * blob into memory).
 *
 * @example
 * <a href={getDownloadUrl(getMediaUrl(key))}>Download</a>
 * <a href={getDownloadUrl(url, { filename: "photo.jpg" })}>Download</a>
 */
export function getDownloadUrl(mediaUrl: string, options?: DownloadUrlOptions): string {
	const separator = mediaUrl.includes("?") ? "&" : "?";
	const value = options?.filename ? `=${encodeURIComponent(options.filename)}` : "";
	return `${mediaUrl}${separator}download${value}`;
}
