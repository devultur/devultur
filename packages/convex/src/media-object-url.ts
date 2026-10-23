"use client";

import type { DevulturMedia } from "@devultur/core";
import { useDevultur } from "./devultur-context";
import { useMediaResource } from "./media-resource";

export interface UseMediaObjectUrlOptions {
	/** `false` → nothing is fetched (e.g. a list row that isn't selected). Default `true`. */
	enabled?: boolean;
	/** Refuses bodies larger than this, by `Content-Length` and while streaming (`MediaFetchError` `too_large`). */
	maxBytes?: number;
	/**
	 * The type you know the media has. The response's `Content-Type` must agree with it, and the object URL is
	 * created with it (`type_mismatch` / `unsupported_type` otherwise). Without it, the object URL keeps the
	 * response's type only when previewable (see the guide's allowlist), else `application/octet-stream`.
	 * With it, public media is fetched and verified too, instead of returning its unverified delivery URL.
	 */
	contentType?: string;
}

export interface MediaObjectUrl {
	/**
	 * `blob:` URL for private media (and public media with `contentType`); the delivery URL for other public media,
	 * whose type is whatever the server says, so don't frame it. `null` while loading, disabled or failed.
	 */
	objectUrl: string | null;
	/** The type the object URL was created with (not the server's verbatim). `null` for an unverified public URL. */
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
 * URL that is revoked when the media changes and on unmount. Public media returns its delivery URL, unfetched,
 * unless `contentType` asks for it to be verified.
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
	// A public URL skips the type checks, so it's only handed out when nobody asked for a verified type.
	const isUnverifiedPublic = media?.visibility === "public" && !options?.contentType;
	const resource = useMediaResource(media, {
		isEnabled: isEnabled && !isUnverifiedPublic,
		maxBytes: options?.maxBytes,
		contentType: options?.contentType,
		decode: createObjectUrl,
		release: revokeObjectUrl,
	});

	if (media && isEnabled && isUnverifiedPublic) {
		return { objectUrl: url(media), contentType: null, isLoading: false, error: null };
	}
	return {
		objectUrl: resource.value,
		contentType: resource.contentType,
		isLoading: resource.isLoading,
		error: resource.error,
	};
}
