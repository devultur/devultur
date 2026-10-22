import type { DevulturMedia } from "@devultur/core";
import type { MediaRecord } from "./types";

// The record's optional fields a reference carries along, when the record has them.
const OPTIONAL_FIELDS = ["width", "height", "title", "alt", "tags", "duration", "pageCount"] as const;

/**
 * The `DevulturMedia` reference of a component record (a `listMedia` row), ready for `<Image>`, `<DownloadLink>` or a
 * `dv.media()` field. `null` for a record without a visibility: one from before 1.1.0, or a video only `processVideo`
 * recorded. A stored reference is a copy: a later `updateMediaMeta` changes the record, not the references to it.
 */
export function mediaFromRecord(record: MediaRecord): DevulturMedia | null {
	if (!record.visibility) return null;
	const optionalFields = Object.fromEntries(
		OPTIONAL_FIELDS.filter((field) => record[field] !== undefined).map((field) => [field, record[field]]),
	);
	return {
		id: record.key,
		kind: record.type,
		visibility: record.visibility,
		filename: record.filename,
		...(record.objectKey ? { key: record.objectKey } : {}),
		sizeBytes: record.sizeBytes,
		...optionalFields,
	};
}
