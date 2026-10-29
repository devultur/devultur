// Which media a virtual key belongs to: `{visibility}/{kind}/{id}/…` for what the Worker names, and
// `{visibility}/asset/{path}` for the client-named assets (the key is their only id).
import type { MediaEventKind, Visibility } from "@devultur/core";
import { ASSET_NAMESPACE, isVideoRawKey } from "@devultur/core";

export interface MediaIdentity {
	mediaId: string;
	kind: MediaEventKind;
	visibility: Visibility;
	/** The media's own key: the folder of a video, the object of anything else. */
	mediaKey: string;
}

const KINDS = new Set(["image", "video", "file"]);
const VARIANTS_SEGMENT = "/__variants/";

/**
 * The media `key` belongs to, or null for a key the Worker doesn't lay out (a bucket-root object, a lock record). An
 * image variant (`{key}/__variants/…`) belongs to its image.
 */
export function mediaOfKey(objectKey: string): MediaIdentity | null {
	const variantsAt = objectKey.indexOf(VARIANTS_SEGMENT);
	const key = variantsAt === -1 ? objectKey : objectKey.slice(0, variantsAt);
	const [visibility, kind, id] = key.split("/");
	if (visibility !== "public" && visibility !== "private") return null;
	if (kind === ASSET_NAMESPACE) return key.length > `${visibility}/${kind}/`.length ? asset(key, visibility) : null;
	if (!KINDS.has(kind) || !id) return null;
	const mediaKey = kind === "video" ? `${visibility}/video/${id}` : key;
	return { mediaId: id, kind: kind as MediaEventKind, visibility, mediaKey };
}

const asset = (key: string, visibility: Visibility): MediaIdentity => ({
	mediaId: key,
	kind: "asset",
	visibility,
	mediaKey: key,
});

/** Whether `key` is a whole media of its own: an image, a file, an asset, or a video's original. */
export function isMediaOriginal(key: string): boolean {
	const media = mediaOfKey(key);
	if (!media || key.includes(VARIANTS_SEGMENT)) return false;
	return media.kind !== "video" || isVideoRawKey(key);
}
