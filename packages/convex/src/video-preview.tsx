"use client";

// `<Preview>`'s video: the streaming `<VideoPlayer>`, which never goes through a blob (it streams HLS and sends the
// session header itself). A refused playlist or segment, or a viewer token that couldn't be issued, renders the
// fallback instead of a player that never starts.
import React from "react";
import type { DevulturMedia } from "@devultur/core";
import { VideoPlayer, type VideoPlayerError } from "@devultur/react";
import { useDevultur } from "./devultur-context";
import { MediaFetchError, networkError, renderFailedError, tokenUnavailableError } from "./media-fetch";
import { useVideoProps } from "./media-url-hooks";
import type { RenderFallback } from "./pdf-preview";

interface VideoPreviewProps {
	media: DevulturMedia;
	renderFallback: RenderFallback;
	/** Shown while a private video waits for its viewer token. */
	loading: React.ReactNode;
	/** `<VideoPlayer metrics>`: `false` turns playback metrics off. */
	metrics?: boolean;
	className?: string;
}

interface PlaybackFailure {
	/** The token the player had: a new one (renewed, re-issued, retried) plays again. */
	token: string | undefined;
	error: MediaFetchError;
}

const UNAUTHORIZED = 401;
// hls.js names its network failures `…LoadError` / `…LoadTimeOut`; the rest are decoding or buffering failures.
const HLS_NETWORK_FAILURE = /Load(Error|TimeOut)$/;

function fetchErrorOf(error: VideoPlayerError): MediaFetchError {
	if (error.status === UNAUTHORIZED && error.code === "session_mismatch") {
		return new MediaFetchError("session_mismatch", "The delivery refused this session's token", UNAUTHORIZED);
	}
	if (error.status === UNAUTHORIZED) return tokenUnavailableError();
	if (error.status) return new MediaFetchError("http_error", `Video fetch failed: ${error.status}`, error.status);
	if (HLS_NETWORK_FAILURE.test(error.details)) return networkError(error);
	return renderFailedError(error);
}

export function VideoPreview({ media, renderFallback, loading, metrics, className }: VideoPreviewProps) {
	const { token, tokenStatus, tokenError, reissueToken } = useDevultur();
	const videoProps = useVideoProps(media);
	const [failure, setFailure] = React.useState<PlaybackFailure | null>(null);
	const hasReissuedRef = React.useRef(false);
	const playerToken = videoProps?.token;

	const handleError = React.useCallback(
		(error: VideoPlayerError) => {
			// A `session_mismatch` re-issues once, like the other fetches; the new token rebuilds the player.
			const isFirstMismatch = error.code === "session_mismatch" && !hasReissuedRef.current;
			if (isFirstMismatch) {
				hasReissuedRef.current = true;
				void reissueToken();
				return;
			}
			setFailure({ token: playerToken, error: fetchErrorOf(error) });
		},
		[reissueToken, playerToken],
	);

	if (!videoProps) return null;
	const isPrivate = media.visibility === "private";
	if (isPrivate && tokenStatus === "error") return <>{renderFallback(tokenUnavailableError(tokenError))}</>;
	// Without a token the playlist request would be refused (a 401) and flash the fallback.
	if (isPrivate && !token) return <>{loading}</>;
	if (failure && failure.token === playerToken) return <>{renderFallback(failure.error)}</>;
	return <VideoPlayer {...videoProps} className={className} metrics={metrics} onError={handleError} />;
}
