"use client";

import React from "react";
import { type DevulturMedia, mediaUrl } from "@devultur/core";
import { useDevultur } from "./devultur-context";
import { fetchMedia, MediaFetchError, tokenUnavailableError } from "./media-fetch";
import { useRequestTokenWhen } from "./request-token";

export interface DownloadLinkProps
	extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "download" | "media"> {
	media: DevulturMedia | null | undefined;
	/** Name it downloads as. Without this it uses the upload's original name. */
	filename?: string;
	/**
	 * A private download that failed: `token_unavailable` right away when the viewer token couldn't be issued
	 * (`useDevultur().retryToken()` tries again), `http_error` when the delivery refused it.
	 */
	onDownloadError?: (error: MediaFetchError) => void;
	children: React.ReactNode;
}

/**
 * `<a>` that downloads a media with its original name (token-transparent). The worker serves it with
 * `Content-Disposition: attachment`, so a click downloads the file instead of opening it in a tab.
 *
 * Private: an `<a download>` NAVIGATES, and a navigation can't send `${SESSION_HEADER}` → with session
 * binding the gate gives a 401. So, for private media, we intercept the click, blob-fetch with the header
 * (like private `<Image>`) and trigger the download from the object URL. Public keeps native navigation.
 */
export function DownloadLink({ media, filename, onDownloadError, children, ...anchorProps }: DownloadLinkProps) {
	const devultur = useDevultur();
	const { url, token, tokenStatus, tokenError, baseUrl, sessionSecret, reissueToken } = devultur;
	useRequestTokenWhen(devultur, media?.visibility === "private");

	const handleClick = React.useCallback(
		async (event: React.MouseEvent<HTMLAnchorElement>) => {
			// Public (or no media/baseUrl) → let the `<a>` navigate (tokenless, cacheable, no header).
			if (media?.visibility !== "private" || !baseUrl) return;
			event.preventDefault();
			if (tokenStatus === "error") {
				onDownloadError?.(tokenUnavailableError(tokenError));
				return;
			}
			// URL with an explicit token → on retry we use the fresh token (the context's `url()` would stay
			// stale inside the handler until the next render).
			const response = await fetchMedia({
				buildUrl: (viewerToken) => mediaUrl(baseUrl, media, { download: filename ?? true, token: viewerToken }),
				token,
				sessionSecret,
				reissueToken,
			});
			if (!response.ok) {
				const status = response.status;
				onDownloadError?.(new MediaFetchError("http_error", `Media fetch failed: ${status}`, status));
				return;
			}
			const objectUrl = URL.createObjectURL(await response.blob());
			const anchor = document.createElement("a");
			anchor.href = objectUrl;
			anchor.download = filename ?? media.filename ?? "download";
			anchor.click();
			URL.revokeObjectURL(objectUrl);
		},
		[media, baseUrl, token, tokenStatus, tokenError, filename, sessionSecret, reissueToken, onDownloadError],
	);

	if (!media) return null;
	return (
		<a href={url(media, { download: filename ?? true })} download {...anchorProps} onClick={handleClick}>
			{children}
		</a>
	);
}
