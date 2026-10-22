// A media record's descriptive metadata: what the app edits (`title`, `alt`, `tags`), the hints an uploading client
// sends (`width`, `height`, `pageCount`), and the `searchText` kept in step with the title and filename. Pure: no
// database, so it is checked the same way in every function that writes a record.
import { ConvexError } from "convex/values";

export const MEDIA_META_LIMITS = {
	titleLength: 200,
	altLength: 1000,
	tagCount: 20,
	tagLength: 50,
	/** Largest width, height or page count a client may report. */
	hintValue: 100_000,
} as const;

export interface UploadHints {
	width?: number;
	height?: number;
	pageCount?: number;
}

export interface MediaMetaInput {
	title?: string;
	alt?: string;
	tags?: string[];
}

/** The fields to patch: a trimmed empty `title` or `alt` clears it (`undefined`), `tags: []` clears the tags. */
export interface MediaMetaPatch {
	title?: string | undefined;
	alt?: string | undefined;
	tags?: string[];
}

function invalidMetadata(field: string, message: string) {
	return new ConvexError({ code: "invalid_media_metadata", message, status: 400, details: { field } });
}

function checkHint(field: keyof UploadHints, value: number | undefined): void {
	if (value === undefined) return;
	if (Number.isInteger(value) && value > 0 && value <= MEDIA_META_LIMITS.hintValue) return;
	throw invalidMetadata(field, `${field} must be a whole number from 1 to ${MEDIA_META_LIMITS.hintValue}`);
}

/** Throws `invalid_media_metadata` unless every hint the client sent is a positive integer within bounds. */
export function checkUploadHints(hints: UploadHints): void {
	checkHint("width", hints.width);
	checkHint("height", hints.height);
	checkHint("pageCount", hints.pageCount);
}

function trimmedText(field: "title" | "alt", value: string, maxLength: number): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length > maxLength) throw invalidMetadata(field, `${field} must be at most ${maxLength} characters`);
	return trimmed === "" ? undefined : trimmed;
}

/** Trimmed, without empty ones or repeats (first spelling wins), within the count and length limits. */
export function normalizeTags(tags: string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const tag of tags) {
		const trimmed = tag.trim();
		if (trimmed === "" || seen.has(trimmed.toLowerCase())) continue;
		if (trimmed.length > MEDIA_META_LIMITS.tagLength) {
			throw invalidMetadata("tags", `Each tag must be at most ${MEDIA_META_LIMITS.tagLength} characters`);
		}
		seen.add(trimmed.toLowerCase());
		normalized.push(trimmed);
	}
	if (normalized.length > MEDIA_META_LIMITS.tagCount) {
		throw invalidMetadata("tags", `A media can have at most ${MEDIA_META_LIMITS.tagCount} tags`);
	}
	return normalized;
}

/** The patch for an edit; only the fields the caller passed are in it. Throws `invalid_media_metadata`. */
export function mediaMetaPatch(input: MediaMetaInput): MediaMetaPatch {
	const patch: MediaMetaPatch = {};
	if (input.title !== undefined) patch.title = trimmedText("title", input.title, MEDIA_META_LIMITS.titleLength);
	if (input.alt !== undefined) patch.alt = trimmedText("alt", input.alt, MEDIA_META_LIMITS.altLength);
	if (input.tags !== undefined) patch.tags = normalizeTags(input.tags);
	return patch;
}

/** What the media library's search matches: the title and the filename, lowercased. */
export function searchTextOf(title: string | undefined, filename: string): string {
	return (title ? `${title} ${filename}` : filename).toLowerCase();
}

interface SearchableRecord {
	title?: string;
	filename: string;
	searchText?: string;
}

/** `{ searchText }` for a record written before 1.4.0 (it has none), else `{}`: spread it into any patch of a record. */
export function missingSearchText(record: SearchableRecord): { searchText?: string } {
	if (record.searchText !== undefined) return {};
	return { searchText: searchTextOf(record.title, record.filename) };
}
