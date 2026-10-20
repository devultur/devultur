// Keys of uploaded objects, as the Worker lays them out. Dependency-free so any module can parse them.
import type { DevulturKind, Visibility } from "@devultur/core";

const KINDS: readonly DevulturKind[] = ["video", "image", "file"];

export interface UploadKey {
	visibility: Visibility;
	kind: DevulturKind;
	id: string;
	/** The (sanitized) filename in the key. */
	storedName: string;
}

/**
 * The parts of an upload key: `{visibility}/{image|file}/{id}/{name}` or `{visibility}/video/{id}/raw/{name}`.
 * `null` for any other key (derivatives, assets, exports): those are never library items.
 */
export function parseUploadKey(key: string): UploadKey | null {
	const segments = key.split("/");
	const [visibility, kind, id] = segments;
	if (visibility !== "public" && visibility !== "private") return null;
	if (!KINDS.includes(kind as DevulturKind) || !id) return null;

	const nameSegments = kind === "video" ? 5 : 4;
	if (segments.length !== nameSegments) return null;
	if (kind === "video" && segments[3] !== "raw") return null;

	const storedName = segments.at(-1);
	if (!storedName) return null;
	return { visibility, kind: kind as DevulturKind, id, storedName };
}
