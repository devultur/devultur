import { sanitizeFilename } from "./filenames";
import { buildMediaUrl, type MediaUrlOptions } from "./media-url";
import { captionPath, filePath, imagePath, videoHlsPlaylistPath, videoThumbnailPath } from "./paths";

export type Visibility = "public" | "private";
export type DevulturKind = "image" | "video" | "file";

/**
 * Typed, serializable reference to a media. Flows upload → store → render without the consumer
 * touching keys, URLs, tokens, or query params. Visibility travels with the reference, so the render
 * decides token/no-token on its own. The delivery PATH is DERIVED from these fields (`mediaPath`) — never
 * persisted — so devultur can change the template without migrating anyone's data.
 *
 * The `V` generic enables `publicUrl`'s compile-time guard (only accepts `<"public">`).
 */
export interface DevulturMedia<V extends Visibility = Visibility> {
	/** Resource uuid, generated server-side on upload. */
	readonly id: string;
	/** image | video | file. */
	readonly kind: DevulturKind;
	/** `public` → tokenless, cacheable delivery; `private` → requires a viewer token. */
	readonly visibility: V;
	/** Original upload name (display / download). */
	readonly filename?: string;
	/**
	 * Key of the uploaded object (`{visibility}/{kind}/{id}/…`; a video's raw file), as the upload returned it. Optional
	 * and informational: delivery paths are still derived from the other fields (`mediaPath`), never from it.
	 */
	readonly key?: string;
	/** Intrinsic width (px) — enables `<img>` with no CLS. */
	readonly width?: number;
	/** Intrinsic height (px). */
	readonly height?: number;
}

/** Visibility default when not specified at any level: secure-by-default. */
export const DEFAULT_VISIBILITY: Visibility = "private";

/**
 * Reads the visibility from the first segment of a virtual key/path (`{visibility}/{kind}/…`). The worker
 * uses it to gate delivery in O(1). Returns null if the first segment isn't a known visibility
 * (legacy keys with no prefix).
 */
export function visibilityFromKey(key: string): Visibility | null {
	const first = key.split("/")[0];
	return first === "public" || first === "private" ? first : null;
}

/**
 * Effective visibility of a resource: upload override → router default → `private`.
 * Omitted everywhere ⇒ private. Nothing is exposed publicly without an explicit decision.
 */
export function resolveVisibility(uploadVisibility?: Visibility, routerVisibility?: Visibility): Visibility {
	return uploadVisibility ?? routerVisibility ?? DEFAULT_VISIBILITY;
}

/**
 * Delivery path (virtual, without the storage prefix) of a media's main resource, with `{visibility}`
 * first so the worker can gate public/private in O(1). For video it returns the HLS playlist
 * (the playable one). Pure function of the reference — the template lives here and changes without touching data.
 */
export function mediaPath(media: DevulturMedia): string {
	// The filename is sanitized the same way as on upload (`sanitizeFilename`, idempotent) → the delivery
	// path mirrors EXACTLY the key the worker stored. Without this, a name with a space/accent is requested
	// raw but the object lives under the sanitized one → 404. `filename` remains the pretty name for UI/download.
	const name = sanitizeFilename(media.filename ?? media.id);
	const kindPath =
		media.kind === "video"
			? videoHlsPlaylistPath(media.id)
			: media.kind === "image"
				? imagePath(media.id, name)
				: filePath(media.id, name);
	return `${media.visibility}/${kindPath}`;
}

/** Path of a video's thumbnail (null for image/file). Same visibility prefix. */
export function mediaThumbnailPath(media: DevulturMedia): string | null {
	if (media.kind !== "video") return null;
	return `${media.visibility}/${videoThumbnailPath(media.id)}`;
}

/** Path of a video's subtitle .vtt for a locale (null for image/file). Same prefix. */
export function mediaCaptionPath(media: DevulturMedia, locale: string): string | null {
	if (media.kind !== "video") return null;
	return `${media.visibility}/${captionPath(media.id, locale)}`;
}

/**
 * A media's delivery URL from its reference. **Token-transparent**: for `private` it injects
 * `options`' `token`; for `public` it ALWAYS omits it (stable, cacheable, crawler-safe URL). The
 * rest of `options` (transforms, download) is composed via `buildMediaUrl`.
 */
export function mediaUrl(baseUrl: string, media: DevulturMedia, options?: MediaUrlOptions): string {
	const token = media.visibility === "private" ? options?.token : undefined;
	return buildMediaUrl(baseUrl, mediaPath(media), { ...options, token });
}

/**
 * A media's stable public URL. Only accepts `DevulturMedia<"public">`, so passing something private
 * (e.g. to an `og:image`) is a **compile error**. Never attaches a token → cacheable and crawler-safe.
 */
export function publicUrl(
	baseUrl: string,
	media: DevulturMedia<"public">,
	options?: Omit<MediaUrlOptions, "token">,
): string {
	return buildMediaUrl(baseUrl, mediaPath(media), options);
}
