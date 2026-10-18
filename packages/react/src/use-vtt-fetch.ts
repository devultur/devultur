"use client";

import React from "react";
import { SESSION_HEADER } from "@devultur/core";
import type { CaptionTrack } from "./types";
import { parseVtt, type VttCue } from "./vtt-parser";

interface UseVttFetchOptions {
	captions?: CaptionTrack[];
	locale: string | null;
	token?: string;
	sessionSecret?: string;
}

interface UseVttFetchReturn {
	cues: VttCue[];
	isLoading: boolean;
}

export function useVttFetch({ captions, locale, token, sessionSecret }: UseVttFetchOptions): UseVttFetchReturn {
	const [cues, setCues] = React.useState<VttCue[]>([]);
	const [isLoading, setIsLoading] = React.useState(false);
	const cacheRef = React.useRef<Map<string, VttCue[]>>(new Map());

	React.useEffect(() => {
		if (!locale || !captions?.length) {
			setCues([]);
			return;
		}

		const track = captions.find((caption) => caption.locale === locale);
		if (!track) {
			setCues([]);
			return;
		}

		const cached = cacheRef.current.get(locale);
		if (cached) {
			setCues(cached);
			return;
		}

		let cancelled = false;
		setIsLoading(true);
		const trackSrc = token ? `${track.src}${track.src.includes("?") ? "&" : "?"}token=${token}` : track.src;

		fetch(trackSrc, { headers: sessionSecret ? { [SESSION_HEADER]: sessionSecret } : undefined })
			.then((response) => {
				if (!response.ok) throw new Error(`VTT fetch failed: ${response.status}`);
				return response.text();
			})
			.then((vttText) => {
				if (cancelled) return;
				const parsed = parseVtt(vttText);
				cacheRef.current.set(locale, parsed);
				setCues(parsed);
			})
			.catch(() => {
				if (!cancelled) setCues([]);
			})
			.finally(() => {
				if (!cancelled) setIsLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [locale, captions, token, sessionSecret]);

	return { cues, isLoading };
}
