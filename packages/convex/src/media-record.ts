import type { DevulturMedia } from "@devultur/core";
import type { MediaRecord } from "./types";

/**
 * The `DevulturMedia` reference of a component record (a `listMedia` row), ready for `<Image>`, `<DownloadLink>` or a
 * `dv.media()` field. `null` for a record without a visibility: one from before 1.1.0, or a video only `processVideo`
 * recorded.
 */
export function mediaFromRecord(record: MediaRecord): DevulturMedia | null {
	if (!record.visibility) return null;
	return {
		id: record.key,
		kind: record.type,
		visibility: record.visibility,
		filename: record.filename,
		...(record.objectKey ? { key: record.objectKey } : {}),
		...(record.width !== undefined ? { width: record.width } : {}),
		...(record.height !== undefined ? { height: record.height } : {}),
	};
}
