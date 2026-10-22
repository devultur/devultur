// Which content types render inline, and the type a fetched body may be trusted with. Pure (no React).
//
// Why an allowlist: an object URL (`blob:`) is same-origin with the app that created it. Rendering an uploaded HTML,
// SVG or XML file from one (in an `<iframe>`, or navigated to) runs its scripts with the app's cookies and storage.
// Browsers render a blob by the type it was created with, so the type is decided here, never taken verbatim from
// the server: it has to be allowlisted, and the media's known type and the response's `Content-Type` have to agree.
// It's the client-side counterpart of `X-Content-Type-Options: nosniff`: a declared type is never upgraded into one
// that executes. Anything else falls back to a download.
import type { DevulturMedia } from "@devultur/core";

/** How a content type renders inline: `<img>`, a PDF view (pdf.js canvases or `<iframe>`), `<audio>` or `<pre>`. */
export type PreviewKind = "image" | "pdf" | "audio" | "text";

/** Never SVG (it carries script), never HTML/XML/XHTML. Video goes through the streaming player, not a blob. */
const PREVIEW_KIND_BY_TYPE = new Map<string, PreviewKind>([
	["image/png", "image"],
	["image/jpeg", "image"],
	["image/webp", "image"],
	["image/gif", "image"],
	["image/avif", "image"],
	["application/pdf", "pdf"],
	["audio/mpeg", "audio"],
	["audio/mp4", "audio"],
	["audio/aac", "audio"],
	["audio/ogg", "audio"],
	["audio/wav", "audio"],
	["audio/webm", "audio"],
	["audio/flac", "audio"],
	["text/plain", "text"],
	["text/csv", "text"],
	["application/json", "text"],
]);

const TYPE_BY_EXTENSION = new Map<string, string>([
	["png", "image/png"],
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["webp", "image/webp"],
	["gif", "image/gif"],
	["avif", "image/avif"],
	["pdf", "application/pdf"],
	["mp3", "audio/mpeg"],
	["m4a", "audio/mp4"],
	["aac", "audio/aac"],
	["ogg", "audio/ogg"],
	["oga", "audio/ogg"],
	["opus", "audio/ogg"],
	["wav", "audio/wav"],
	["weba", "audio/webm"],
	["flac", "audio/flac"],
	["txt", "text/plain"],
	["csv", "text/csv"],
	["json", "application/json"],
]);

/** Fallback blob type: navigating to it downloads instead of rendering. */
export const OPAQUE_CONTENT_TYPE = "application/octet-stream";

/** `"Text/HTML; charset=utf-8"` → `"text/html"`. */
export function normalizeContentType(value: string | null | undefined): string | null {
	const essence = value?.split(";")[0]?.trim().toLowerCase();
	return essence || null;
}

/** The inline element for a content type, or `null` when it must not render inline. */
export function previewKindOf(contentType: string | null | undefined): PreviewKind | null {
	const normalized = normalizeContentType(contentType);
	if (!normalized) return null;
	return PREVIEW_KIND_BY_TYPE.get(normalized) ?? null;
}

/** The type a media is known to have: the one the app declares, else the one its filename's extension implies. */
export function expectedContentType(media: DevulturMedia, declaredType?: string): string | null {
	if (declaredType) return normalizeContentType(declaredType);
	const extension = media.filename?.split(".").pop()?.toLowerCase();
	if (!extension || extension === media.filename?.toLowerCase()) return null;
	return TYPE_BY_EXTENSION.get(extension) ?? null;
}

export type TrustedContentType =
	| { ok: true; contentType: string }
	| { ok: false; reason: "unsupported_type" | "type_mismatch" };

/**
 * The type to create a blob with. With an expected type, both it and the response's type must be allowlisted and
 * render the same way, and the blob takes the expected type. Without one, an allowlisted response type is kept and
 * anything else becomes `application/octet-stream`.
 */
export function trustedContentType(
	expectedType: string | null | undefined,
	responseType: string | null | undefined,
): TrustedContentType {
	const receivedKind = previewKindOf(responseType);
	if (!expectedType) {
		const contentType = receivedKind ? normalizeContentType(responseType) : null;
		return { ok: true, contentType: contentType ?? OPAQUE_CONTENT_TYPE };
	}
	const expectedKind = previewKindOf(expectedType);
	if (!expectedKind) return { ok: false, reason: "unsupported_type" };
	if (receivedKind !== expectedKind) return { ok: false, reason: "type_mismatch" };
	return { ok: true, contentType: normalizeContentType(expectedType) ?? OPAQUE_CONTENT_TYPE };
}
