"use client";

// What both providers share: the browser session secret, the viewer token and the delivery helpers built on them.
import React from "react";
import {
	buildMediaUrl,
	type DevulturMedia,
	type MediaUrlOptions,
	mediaCaptionPath,
	mediaUrl,
	SESSION_HEADER,
} from "@devultur/core";
import { useAction } from "convex/react";
import type { FunctionReference } from "convex/server";
import { isSessionMismatch } from "./image-recovery";
import { type TokenStatus, useViewerToken, type ViewerTokenArgs } from "./viewer-token";

/** Transform/delivery options for media URLs (without `token`, which the context injects). */
export type MediaRenderOptions = Omit<MediaUrlOptions, "token">;

export type ViewerTokenAction = FunctionReference<"action", "public", { sessionSecret: string }>;

export interface MediaSession {
	token: string | null;
	/** Where the viewer token stands; `"error"` makes private previews fail fast with `token_unavailable`. */
	tokenStatus: TokenStatus;
	/** Why the last issuance failed (the action threw or returned no token), while `tokenStatus` is `"error"`. */
	tokenError: Error | null;
	/** Issues the viewer token again (after a failure, for example). Resolves to the new token, or `null`. */
	retryToken: () => Promise<string | null>;
	baseUrl: string | null;
	/** Browser session secret → sent in `${SESSION_HEADER}` on every private delivery. */
	sessionSecret: string;
	/** Delivery URL from a reference (non-hook → usable in handlers and `.map`). Token-transparent. */
	url: (media: DevulturMedia, options?: MediaRenderOptions) => string;
	/** Downloads a video's subtitle text for a locale (auth-transparent). */
	getCaptionsText: (media: DevulturMedia, locale: string) => Promise<string>;
	/**
	 * Re-issues the viewer token (new session fingerprint with the current UA/IP) and updates the context.
	 * Single-flight: concurrent calls share the same issuance. Returns the new token (or null if it
	 * failed). The render uses it to transparently recover from a 401 `session_mismatch`.
	 */
	reissueToken: () => Promise<string | null>;
}

interface MediaSessionOptions {
	issueViewerToken: ViewerTokenAction;
	tokenArgs?: ViewerTokenArgs;
	baseUrl?: string;
}

export function useMediaSession({ issueViewerToken, tokenArgs, baseUrl }: MediaSessionOptions): MediaSession {
	// Client session secret: generated ONCE (in memory, per app session), bound to the token at
	// issuance, and sent in `${SESSION_HEADER}` on every delivery → real session binding (works even
	// when the token is issued server-side). Empty outside the browser (SSR) → no binding.
	const [sessionSecret] = React.useState(() => (typeof crypto !== "undefined" ? crypto.randomUUID() : ""));
	const issueViewerTokenAction = useAction(issueViewerToken);
	const { token, tokenStatus, tokenError, reissueToken, retryToken } = useViewerToken({
		issueViewerToken: issueViewerTokenAction,
		sessionSecret,
		tokenArgs,
	});

	const url = React.useCallback(
		(media: DevulturMedia, options?: MediaRenderOptions): string => {
			if (!baseUrl) throw new Error("Devultur `url()` requires `baseUrl` on <DevulturProvider>");
			return mediaUrl(baseUrl, media, { ...options, token: token ?? undefined });
		},
		[baseUrl, token],
	);

	const getCaptionsText = React.useCallback(
		async (media: DevulturMedia, locale: string): Promise<string> => {
			if (!baseUrl) throw new Error("Devultur `getCaptionsText()` requires `baseUrl` on <DevulturProvider>");
			const path = mediaCaptionPath(media, locale);
			if (!path) throw new Error("getCaptionsText: the reference is not a video");
			const isPrivate = media.visibility === "private";

			const fetchWith = (viewerToken: string | undefined) =>
				fetch(buildMediaUrl(baseUrl, path, { token: viewerToken }), {
					headers: sessionSecret ? { [SESSION_HEADER]: sessionSecret } : undefined,
				});

			let response = await fetchWith(isPrivate ? (token ?? undefined) : undefined);
			// 401 `session_mismatch` → re-issue once and retry. Transparent.
			if (isPrivate && response.status === 401 && (await isSessionMismatch(response))) {
				const fresh = await reissueToken();
				if (fresh) response = await fetchWith(fresh);
			}
			if (!response.ok) throw new Error(`Captions fetch failed: ${response.status}`);
			return response.text();
		},
		[baseUrl, token, reissueToken, sessionSecret],
	);

	return React.useMemo(
		() => ({
			token,
			tokenStatus,
			tokenError,
			retryToken,
			baseUrl: baseUrl ?? null,
			sessionSecret,
			url,
			getCaptionsText,
			reissueToken,
		}),
		[token, tokenStatus, tokenError, retryToken, baseUrl, sessionSecret, url, getCaptionsText, reissueToken],
	);
}
