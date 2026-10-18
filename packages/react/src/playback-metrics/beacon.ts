// Where a view's beacons go and how they leave the page. The endpoint is the playback URL's own origin, so the
// worker sees the same host that served the video (no credential in the browser).
import type { PlaybackBeacon } from "./collector";

type OutgoingBeacon = PlaybackBeacon & { token?: string };

const MEDIA_PATH_MARKER = "/v1/media/";
export const PLAYBACK_METRICS_PATH = "/v1/metrics/playback";

export interface PlaybackMetricsTarget {
	endpoint: string;
	/** Media key after `/v1/media/`, without query (the token never leaves in a beacon). */
	key: string;
}

/** Endpoint + media key from a Devultur delivery URL; null for any other source (metrics stay off). */
export function resolveMetricsTarget(src: string, baseOrigin?: string): PlaybackMetricsTarget | null {
	let url: URL;
	try {
		url = new URL(src, baseOrigin);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	const markerIndex = url.pathname.indexOf(MEDIA_PATH_MARKER);
	if (markerIndex < 0) return null;
	const key = url.pathname.slice(markerIndex + MEDIA_PATH_MARKER.length);
	if (!key) return null;
	const pathPrefix = url.pathname.slice(0, markerIndex);
	return { endpoint: `${url.origin}${pathPrefix}${PLAYBACK_METRICS_PATH}`, key };
}

/**
 * Only a viewer JWT may ride in a beacon. `token` on the player is opaque and can also be a long-lived credential
 * (hls.js sends it as a Bearer): anything that is not JWT-shaped never goes into a beacon.
 */
export function isViewerToken(token: string | undefined): token is string {
	if (!token) return false;
	return token.split(".").length === 3;
}

/** Random per-view id. Not derived from the device or the user: two views of the same video never match. */
export function createViewId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Sends one batch. `text/plain` keeps it a CORS "simple" request (no preflight) and `sendBeacon` survives the
 * page unloading. Fire-and-forget: a lost beacon is a missing sample, never an error for the viewer.
 */
export function sendPlaybackBeacon(endpoint: string, beacon: OutgoingBeacon): void {
	const body = JSON.stringify(beacon);
	try {
		if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
			const isQueued = navigator.sendBeacon(endpoint, new Blob([body], { type: "text/plain" }));
			if (isQueued) return;
		}
		if (typeof fetch !== "function") return;
		fetch(endpoint, {
			method: "POST",
			body,
			keepalive: true,
			mode: "no-cors",
			credentials: "omit",
			headers: { "Content-Type": "text/plain" },
		}).catch(() => {});
	} catch {}
}
