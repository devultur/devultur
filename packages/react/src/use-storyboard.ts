"use client";

import React from "react";
import { SESSION_HEADER } from "@devultur/core";
import { parseStoryboardVtt, type StoryboardCue, withStoryboardToken } from "./storyboard";

interface UseStoryboardOptions {
	/** Storyboard VTT URL (`buildStoryboardUrl` from `@devultur/core`). Undefined disables it. */
	src?: string;
	/** Viewer token for private media: the worker rewrites every sprite URL with it. */
	token?: string;
	/** Session secret (session binding): sprites are then fetched with the header and shown as blob URLs. */
	sessionSecret?: string;
}

function sessionHeaders(sessionSecret: string | undefined): HeadersInit | undefined {
	return sessionSecret ? { [SESSION_HEADER]: sessionSecret } : undefined;
}

// Session binding: an <img>/CSS background can't send the session header, so each sheet is fetched once with it.
async function toBlobUrls(cues: StoryboardCue[], sessionSecret: string, blobUrls: string[]): Promise<StoryboardCue[]> {
	const sheets = [...new Set(cues.map((cue) => cue.url))];
	const resolved = new Map<string, string>();
	await Promise.all(
		sheets.map(async (sheetUrl) => {
			const response = await fetch(sheetUrl, { headers: sessionHeaders(sessionSecret) });
			if (!response.ok) throw new Error(`Storyboard sprite failed: ${response.status}`);
			const blobUrl = URL.createObjectURL(await response.blob());
			blobUrls.push(blobUrl);
			resolved.set(sheetUrl, blobUrl);
		}),
	);
	return cues.map((cue) => ({ ...cue, url: resolved.get(cue.url) ?? cue.url }));
}

/**
 * Loads a storyboard (sprite sheets + WebVTT) for seek bar hover previews. Returns no cues while loading or when
 * the storyboard is missing; a failure never affects playback.
 */
export function useStoryboard({ src, token, sessionSecret }: UseStoryboardOptions): StoryboardCue[] {
	const [cues, setCues] = React.useState<StoryboardCue[]>([]);

	React.useEffect(() => {
		setCues([]);
		if (!src) return;
		let isCancelled = false;
		const blobUrls: string[] = [];
		const vttUrl = withStoryboardToken(src, token);

		fetch(vttUrl, { headers: sessionHeaders(sessionSecret) })
			.then((response) => {
				if (!response.ok) throw new Error(`Storyboard fetch failed: ${response.status}`);
				return response.text();
			})
			.then((vttText) => {
				const parsed = parseStoryboardVtt(vttText, new URL(vttUrl, window.location.href).toString());
				return sessionSecret ? toBlobUrls(parsed, sessionSecret, blobUrls) : parsed;
			})
			.then((loaded) => {
				// Sprites that finished after cleanup: release them here (cleanup already ran).
				if (isCancelled) {
					for (const blobUrl of blobUrls) URL.revokeObjectURL(blobUrl);
					return;
				}
				setCues(loaded);
			})
			.catch(() => {
				if (!isCancelled) setCues([]);
			});

		return () => {
			isCancelled = true;
			for (const blobUrl of blobUrls) URL.revokeObjectURL(blobUrl);
		};
	}, [src, token, sessionSecret]);

	return cues;
}
