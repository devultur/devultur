"use client";

import type { DevulturMedia } from "@devultur/core";
import { useMediaResource } from "./media-resource";
import { normalizeContentType } from "./preview-type";
import { useDevultur } from "./react";

export interface UseMediaObjectUrlOptions {
	/** `false` → nothing is fetched (e.g. a list row that isn't selected). Default `true`. */
	enabled?: boolean;
	/** Refuses bodies larger than this, by `Content-Length` and while streaming (`MediaFetchError` `too_large`). */
	maxBytes?: number;
	/**
	 * The type you know the media has. The response's `Content-Type` must agree with it, and the object URL is
	 * created with it (`type_mismatch` / `unsupported_type` otherwise). Without it, the object URL keeps the
	 * response's type only when previewable (see the guide's allowlist), else `application/octet-stream`.
	 */
	contentType?: string;
}

export interface MediaObjectUrl {
	/** `blob:` URL for private media, the delivery URL for public media, `null` while loading, disabled or failed. */
	objectUrl: string | null;
	/** The type the object URL was created with (not the server's verbatim). Public media: the `contentType` option. */
	contentType: string | null;
	isLoading: boolean;
	/** A `MediaFetchError` (stable `code`), or a network error. */
	error: Error | null;
}

const createObjectUrl = (bytes: Uint8Array<ArrayBuffer>, contentType: string) =>
	URL.createObjectURL(new Blob([bytes], { type: contentType }));
const revokeObjectUrl = (objectUrl: string) => URL.revokeObjectURL(objectUrl);

/**
 * An in-memory URL for any media, for elements that can't send headers (`<iframe>`, `<audio>`, `<img>`). Private
 * media is fetched with the session header (one re-issue and retry on a 401 `session_mismatch`) into an object
 * URL that is revoked when the media changes and on unmount. Public media returns its delivery URL, unfetched.
 *
 * @example
 * const { objectUrl, error } = useMediaObjectUrl(document.file, { contentType: "application/pdf", maxBytes: 20e6 });
 * return objectUrl && <iframe src={objectUrl} title={document.file.filename} />;
 */
export function useMediaObjectUrl(
	media: DevulturMedia | null | undefined,
	options?: UseMediaObjectUrlOptions,
): MediaObjectUrl {
	const { url } = useDevultur();
	const isEnabled = (options?.enabled ?? true) && Boolean(media);
	const isPublic = media?.visibility === "public";
	const resource = useMediaResource(media, {
		isEnabled: isEnabled && !isPublic,
		maxBytes: options?.maxBytes,
		contentType: options?.contentType,
		decode: createObjectUrl,
		release: revokeObjectUrl,
	});

	if (media && isEnabled && isPublic) {
		return {
			objectUrl: url(media),
			contentType: normalizeContentType(options?.contentType),
			isLoading: false,
			error: null,
		};
	}
	return {
		objectUrl: resource.value,
		contentType: resource.contentType,
		isLoading: resource.isLoading,
		error: resource.error,
	};
}
