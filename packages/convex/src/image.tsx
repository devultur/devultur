"use client";

import React from "react";
import { type DevulturMedia, type MediaUrlOptions, mediaUrl } from "@devultur/core";
import { fetchMedia } from "./media-fetch";
import { useDevultur } from "./react";
import { buildSrcSet, normalizeWidths, pickWidth, renderedWidthFromSizes, scaledHeight } from "./responsive-image";

type ImageTransforms = Pick<MediaUrlOptions, "width" | "height" | "fit" | "format" | "quality">;

export interface ImageProps
	extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src" | "srcSet" | "width" | "height"> {
	/** Typed reference. `null`/`undefined` → renders `fallback` (or `externalFallback`). Its `alt` is the default `alt`. */
	media: DevulturMedia | null | undefined;
	/** Resize width (px). With `widths`, the width a private image is picked for when `sizes` can't tell. */
	width?: number;
	/** Resize height (px). With `widths` and `width`, it sets the ratio every variant keeps. */
	height?: number;
	fit?: MediaUrlOptions["fit"];
	format?: MediaUrlOptions["format"];
	quality?: number;
	/**
	 * Responsive widths (px). Public images get a `srcset` with one transformed variant per width, and default to
	 * `loading="lazy"` and `decoding="async"`. Private images are fetched once, at the largest width up to twice the
	 * width `sizes` (or `width`) gives them: a `blob:` URL can't be a `srcset` candidate.
	 */
	widths?: readonly number[];
	/** What to show when there's no media (or it's loading). */
	fallback?: React.ReactNode;
	/** Explicit external URL (e.g. Unsplash) when `media` is null or the load fails. */
	externalFallback?: string;
	/** background-image mode: composes the URL as this element's `background-image` (doesn't force `<img>`). */
	render?: React.ReactElement<{ style?: React.CSSProperties }>;
}

/**
 * Renders any media declaratively: token-transparent, with typed transforms, and works inside a
 * `.map()` (no wrappers or hooks rules on the consumer's side).
 *
 * @example
 * <Image media={course.thumbnail} alt={course.title} width={512} format="webp" fallback={<Placeholder />} />
 * <Image media={post.cover} widths={[480, 960, 1440]} sizes="(min-width: 768px) 50vw, 100vw" format="webp" />
 */
export function Image({
	media,
	width,
	height,
	fit,
	format,
	quality,
	widths,
	sizes,
	fallback = null,
	externalFallback,
	render,
	alt,
	...imgProps
}: ImageProps) {
	const { url } = useDevultur();
	const isPrivate = media?.visibility === "private";
	const responsiveWidths = widths?.length ? normalizeWidths(widths) : null;
	const variantOf = (variantWidth: number): ImageTransforms => ({
		width: variantWidth,
		height: scaledHeight(variantWidth, width, height),
		fit,
		format,
		quality,
	});

	let transforms: ImageTransforms = { width, height, fit, format, quality };
	if (responsiveWidths && isPrivate) {
		const pickedWidth = pickWidth(responsiveWidths, renderedWidthFromSizes(sizes) ?? width ?? null);
		if (pickedWidth) transforms = variantOf(pickedWidth);
	}
	const { blobSrc, isFailed, handleError } = usePrivateImage(media, transforms);

	// effective src: failure or no media → `externalFallback`; private → blob object URL (null while loading
	// → `fallback` placeholder); public → direct URL.
	let src: string | null;
	let responsiveProps: React.ImgHTMLAttributes<HTMLImageElement> = {};
	if (isFailed || !media) {
		src = externalFallback ?? null;
	} else if (isPrivate) {
		src = blobSrc;
	} else if (responsiveWidths) {
		const largestWidth = responsiveWidths.at(-1) as number;
		src = url(media, variantOf(largestWidth));
		const srcSet = buildSrcSet(responsiveWidths, (variantWidth) => url(media, variantOf(variantWidth)));
		responsiveProps = { srcSet, sizes };
	} else {
		src = url(media, transforms);
	}

	if (!src) return <>{fallback}</>;

	if (render) {
		return React.cloneElement(render, {
			style: { ...render.props.style, backgroundImage: `url("${src}")` },
		});
	}

	const lazyProps: React.ImgHTMLAttributes<HTMLImageElement> = responsiveWidths
		? { loading: "lazy", decoding: "async" }
		: {};
	return (
		<img
			src={src}
			alt={alt ?? media?.alt}
			width={width ?? media?.width}
			height={height ?? media?.height}
			onError={handleError}
			{...lazyProps}
			{...responsiveProps}
			{...imgProps}
		/>
	);
}

/**
 * Private media: `<img src>` is native → can't send headers, so delivery with session binding would give a 401.
 * Like video (hls.js) and captions, it's fetched with `${SESSION_HEADER}` into an object URL, and THAT goes in the
 * src. It waits for the first viewer token; on a 401 `session_mismatch` `fetchMedia` re-issues once and retries with
 * the fresh token. Public stays native, and only its load failure is tracked here.
 */
function usePrivateImage(media: DevulturMedia | null | undefined, transforms: ImageTransforms) {
	const { token, baseUrl, reissueToken, sessionSecret } = useDevultur();
	const [isFailed, setIsFailed] = React.useState(false);
	const [blobSrc, setBlobSrc] = React.useState<string | null>(null);
	// Read when the fetch starts: a re-issued or renewed token must not re-run the fetch (each run downloads the file again).
	const sessionRef = React.useRef({ token, reissueToken });
	React.useEffect(() => {
		sessionRef.current = { token, reissueToken };
	});

	const isPrivate = media?.visibility === "private";
	const hasToken = token !== null;
	const { width, height, fit, format, quality } = transforms;

	// New media → resets the error state (allows reloading and retrying from scratch).
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional, reset when media changes.
	React.useEffect(() => {
		setIsFailed(false);
		setBlobSrc(null);
	}, [media]);

	React.useEffect(() => {
		if (!isPrivate || isFailed || !media || !hasToken) return;
		let cancelled = false;
		let objectUrl: string | null = null;
		if (!baseUrl) throw new Error("Devultur `url()` requires `baseUrl` on <DevulturProvider>");
		const fetchTransforms = { width, height, fit, format, quality };
		(async () => {
			try {
				const response = await fetchMedia({
					buildUrl: (viewerToken) => mediaUrl(baseUrl, media, { ...fetchTransforms, token: viewerToken }),
					token: sessionRef.current.token,
					sessionSecret,
					reissueToken: sessionRef.current.reissueToken,
				});
				if (response.ok) {
					objectUrl = URL.createObjectURL(await response.blob());
					if (cancelled) {
						URL.revokeObjectURL(objectUrl);
						return;
					}
					setBlobSrc(objectUrl);
					return;
				}
			} catch {
				// network down / CORS → definitive failure.
			}
			if (!cancelled) setIsFailed(true);
		})();
		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [isPrivate, isFailed, media, hasToken, baseUrl, sessionSecret, width, height, fit, format, quality]);

	// `<img>` doesn't expose the failure status. Public → direct fallback. Private goes through the blob-fetch
	// above (which handles its own recovery); if the object URL still fails, it's definitive → fallback.
	const handleError = React.useCallback(() => setIsFailed(true), []);
	return { blobSrc, isFailed, handleError };
}
