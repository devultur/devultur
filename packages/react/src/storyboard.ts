import { parseVtt } from "./vtt-parser";

/**
 * One storyboard thumbnail: the time range it covers and its crop inside a sprite sheet.
 */
export interface StoryboardCue {
	start: number;
	end: number;
	/** Absolute sprite sheet URL (resolved against the VTT URL, query such as `?token=` kept). */
	url: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

const XYWH = /^(.*)#xywh=(\d+),(\d+),(\d+),(\d+)$/;

/**
 * Parses a storyboard WebVTT (`sprite-0.jpg#xywh=x,y,w,h` per cue) into cues with absolute sprite URLs.
 * Cues without an `#xywh` fragment are skipped.
 */
export function parseStoryboardVtt(vttText: string, vttUrl: string): StoryboardCue[] {
	return parseVtt(vttText).flatMap((cue) => {
		const match = XYWH.exec(cue.text.trim());
		if (!match) return [];
		const [, file = "", x, y, width, height] = match;
		return [
			{
				start: cue.start,
				end: cue.end,
				url: new URL(file, vttUrl).toString(),
				x: Number(x),
				y: Number(y),
				width: Number(width),
				height: Number(height),
			},
		];
	});
}

/** Cue covering `time` (cues are sorted by start), or null outside the storyboard. */
export function storyboardCueAt(cues: readonly StoryboardCue[], time: number): StoryboardCue | null {
	let low = 0;
	let high = cues.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const cue = cues[middle];
		if (!cue) return null;
		if (time < cue.start) high = middle - 1;
		else if (time >= cue.end) low = middle + 1;
		else return cue;
	}
	return null;
}

/** Appends the viewer token to a storyboard URL unless it already carries one. */
export function withStoryboardToken(url: string, token: string | undefined): string {
	if (!token || /[?&]token=/.test(url)) return url;
	return `${url}${url.includes("?") ? "&" : "?"}token=${token}`;
}
