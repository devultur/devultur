"use client";

// The hooks that turn a media reference into a delivery URL and `<VideoPlayer>`'s props, token-transparent. They
// read the context only (no Convex client), so `@devultur/convex/react/hooks` exports them.
import React from "react";
import {
	buildMediaUrl,
	CaptionLocaleLabel,
	type DevulturMedia,
	mediaCaptionPath,
	mediaPath,
	visibilityFromKey,
} from "@devultur/core";
import type { MediaRenderOptions } from "./media-session";
import { useDevultur } from "./provider-hooks";
import { useRequestTokenWhen } from "./request-token";

/**
 * Ready-to-use delivery URL for a key, with the context's viewer token already injected. The consumer
 * never touches the token or the query — it only declares what it wants (download, resize, etc.).
 *
 * @example
 * <img src={useMediaUrl(key)} />
 * <a href={useMediaUrl(key, { download: true })} download>Download</a>
 * <img src={useMediaUrl(key, { width: 512, format: "webp" })} />
 */
export function useMediaUrl(key: string | null | undefined, options?: MediaRenderOptions): string | null {
	const devultur = useDevultur();
	const { token, baseUrl } = devultur;
	useRequestTokenWhen(devultur, Boolean(key) && visibilityFromKey(key ?? "") !== "public");
	return React.useMemo(() => {
		if (!key) return null;
		if (!baseUrl) throw new Error("useMediaUrl requires `baseUrl` on <DevulturProvider>");
		// Token-transparent via the visibility in the key's prefix: public doesn't attach a token.
		const isPublic = visibilityFromKey(key) === "public";
		return buildMediaUrl(baseUrl, key, { ...options, token: isPublic ? undefined : (token ?? undefined) });
	}, [key, baseUrl, token, options]);
}

export interface VideoProps {
	src: string;
	token: string | undefined;
	captions: { locale: string; label: string; src: string }[];
	/** Session secret → `<VideoPlayer>` sends it in `${SESSION_HEADER}` on hls.js/captions requests. */
	sessionSecret?: string;
}

/**
 * Token-transparent props for `<VideoPlayer>` from a video reference: builds the HLS playlist `src`,
 * the viewer `token` (only if private), and the `captions` for the requested locales.
 * The consumer just does `<VideoPlayer {...useVideoProps(lesson.video, { locales })} />`.
 */
export function useVideoProps(
	media: DevulturMedia | null | undefined,
	options?: { locales?: string[] },
): VideoProps | null {
	const devultur = useDevultur();
	const { token, baseUrl, sessionSecret } = devultur;
	useRequestTokenWhen(devultur, media?.kind === "video" && media.visibility === "private");
	const locales = options?.locales;
	return React.useMemo(() => {
		if (media?.kind !== "video") return null;
		if (!baseUrl) throw new Error("useVideoProps requires `baseUrl` on <DevulturProvider>");
		const viewerToken = media.visibility === "private" ? (token ?? undefined) : undefined;
		const captions = (locales ?? []).flatMap((locale) => {
			const path = mediaCaptionPath(media, locale);
			if (!path) return [];
			const label = CaptionLocaleLabel[locale as keyof typeof CaptionLocaleLabel] ?? locale;
			return [{ locale, label, src: buildMediaUrl(baseUrl, path, { token: viewerToken }) }];
		});
		return {
			src: buildMediaUrl(baseUrl, mediaPath(media), { token: viewerToken }),
			token: viewerToken,
			captions,
			sessionSecret: media.visibility === "private" ? sessionSecret : undefined,
		};
	}, [media, baseUrl, token, locales, sessionSecret]);
}
