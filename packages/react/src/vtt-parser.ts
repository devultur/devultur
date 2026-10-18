/**
 * A single parsed WebVTT cue with start/end times in seconds and its text.
 */
export interface VttCue {
	start: number;
	end: number;
	text: string;
}

export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_MINUTE = 60;

export function parseTimestamp(timestamp: string): number {
	const parts = timestamp.trim().split(":");
	if (parts.length === 3) {
		const [hours, minutes, rest] = parts;
		const [seconds, milliseconds] = rest.split(".");
		return (
			Number(hours) * SECONDS_PER_HOUR +
			Number(minutes) * SECONDS_PER_MINUTE +
			Number(seconds) +
			Number(milliseconds ?? 0) / 1000
		);
	}
	const [minutes, rest] = parts;
	const [seconds, milliseconds] = rest.split(".");
	return Number(minutes) * SECONDS_PER_MINUTE + Number(seconds) + Number(milliseconds ?? 0) / 1000;
}

export function parseVtt(vttText: string): VttCue[] {
	const cues: VttCue[] = [];
	const blocks = vttText.replace(/\r\n/g, "\n").split("\n\n");

	for (const block of blocks) {
		const lines = block.trim().split("\n");
		const arrowIndex = lines.findIndex((line) => line.includes("-->"));
		if (arrowIndex === -1) continue;

		const timeLine = lines[arrowIndex];
		const [startStr, endStr] = timeLine.split("-->").map((segment) => segment.trim().split(" ")[0]);
		if (!startStr || !endStr) continue;

		const text = lines
			.slice(arrowIndex + 1)
			.join("\n")
			.trim();
		if (!text) continue;

		cues.push({
			start: parseTimestamp(startStr),
			end: parseTimestamp(endStr),
			text,
		});
	}

	return cues;
}

export function formatCueTime(totalSeconds: number): string {
	const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
	const seconds = Math.floor(totalSeconds % SECONDS_PER_MINUTE);
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
