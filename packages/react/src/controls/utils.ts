import type React from "react";
import { SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from "../vtt-parser";

/**
 * Formats a duration in seconds as `m:ss` (or `h:mm:ss` past an hour).
 */
export function formatTime(seconds: number): string {
	if (!Number.isFinite(seconds)) return "0:00";
	const hours = Math.floor(seconds / SECONDS_PER_HOUR);
	const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
	const secs = Math.floor(seconds % SECONDS_PER_MINUTE);
	const paddedSecs = secs.toString().padStart(2, "0");
	return hours > 0 ? `${hours}:${minutes.toString().padStart(2, "0")}:${paddedSecs}` : `${minutes}:${paddedSecs}`;
}

export function preventArrowDefault(event: React.KeyboardEvent) {
	if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(event.key)) {
		event.preventDefault();
	}
}
