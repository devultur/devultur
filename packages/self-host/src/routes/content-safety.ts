// Delivery serves an object with the Content-Type it was uploaded with. An uploaded HTML, SVG or XML file opened
// from its delivery URL would otherwise render as a document on the media origin and run its scripts. So every
// media response says `nosniff` (the browser never upgrades a declared type into one that executes), and a type
// outside the safe-inline list is also sandboxed (`Content-Security-Policy: sandbox`: no script, opaque origin)
// and served as an attachment, so opening it downloads it.
import type { MiddlewareHandler } from "hono";
import { contentDispositionAttachment } from "../helpers";

/** Types that render inline without running script: images (no SVG), video, audio, PDF, plain data, HLS, captions. */
const SAFE_INLINE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/avif",
	"application/pdf",
	"text/plain",
	"text/csv",
	"application/json",
	"text/vtt",
	"application/vnd.apple.mpegurl",
	"application/x-mpegurl",
]);

/** `video/*` and `audio/*` only ever load into a media element; they never render as a document. */
const SAFE_INLINE_FAMILIES = ["video/", "audio/"];

function contentTypeEssence(contentType: string | null): string {
	return contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function isSafeInlineType(contentType: string | null): boolean {
	const essence = contentTypeEssence(contentType);
	if (SAFE_INLINE_TYPES.has(essence)) return true;
	return SAFE_INLINE_FAMILIES.some((family) => essence.startsWith(family));
}

// `inline; filename=…` keeps its (RFC 5987) name and only becomes `attachment`; no disposition → the key's basename.
function attachmentOf(disposition: string | null, filename: string): string {
	if (disposition?.startsWith("attachment")) return disposition;
	if (disposition?.startsWith("inline")) return `attachment${disposition.slice("inline".length)}`;
	return contentDispositionAttachment(filename || "download");
}

/** Sets the safety headers on a media response's headers. Idempotent. */
export function applyContentSafety(headers: Headers, filename: string): void {
	headers.set("X-Content-Type-Options", "nosniff");
	if (isSafeInlineType(headers.get("Content-Type"))) return;
	headers.set("Content-Security-Policy", "sandbox");
	headers.set("Content-Disposition", attachmentOf(headers.get("Content-Disposition"), filename));
}

function basenameOf(url: string): string {
	const last = new URL(url).pathname.split("/").pop() ?? "";
	try {
		return decodeURIComponent(last);
	} catch {
		return last;
	}
}

/**
 * Applies `applyContentSafety` to every response of a router, including edge-cache hits, playlists, transforms and
 * errors. Responses with immutable headers (a subrequest's) are copied first.
 */
export const contentSafety: MiddlewareHandler = async (context, next) => {
	await next();
	const headers = new Headers(context.res.headers);
	applyContentSafety(headers, basenameOf(context.req.url));
	const { body, status, statusText } = context.res;
	context.res = new Response(body, { status, statusText, headers });
};
