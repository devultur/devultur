// Turns an hls.js `ERROR` event into a `VideoPlayerError`, or `null` for one playback can survive. A 401 is reported
// even when not fatal: the token or the session was refused, so retrying the same request won't help.
import type { VideoPlayerError } from "./types";

/** The parts of hls.js's `ErrorData` read here. */
export interface HlsErrorData {
	fatal: boolean;
	details: string;
	response?: { code?: number; data?: unknown };
	networkDetails?: unknown;
}

const UNAUTHORIZED = 401;

export function videoPlayerErrorOf(data: HlsErrorData): VideoPlayerError | null {
	const status = data.response?.code || undefined;
	if (!data.fatal && status !== UNAUTHORIZED) return null;
	return { status, code: errorCodeOf(data), fatal: data.fatal, details: data.details };
}

// The delivery's refusals are JSON (`{ code, message }`). The body is on the loader's XHR (`networkDetails`): text for
// playlists, an ArrayBuffer for segments.
function errorCodeOf(data: HlsErrorData): string | undefined {
	const body = bodyTextOf(data.response?.data) ?? bodyTextOf((data.networkDetails as { response?: unknown })?.response);
	if (!body) return undefined;
	try {
		const parsed = JSON.parse(body) as { code?: unknown };
		return typeof parsed.code === "string" ? parsed.code : undefined;
	} catch {
		return undefined;
	}
}

function bodyTextOf(body: unknown): string | null {
	if (typeof body === "string") return body;
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
	return null;
}
