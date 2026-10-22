// What a media picker's `accept` lets through: files to upload, and records of the library.
import type { MediaRecord } from "./types";

type MediaType = MediaRecord["type"];

/** A file's name and type, or a record's filename and content type. */
interface Candidate {
	name: string;
	type: string;
}

/**
 * Whether `candidate` matches one of the `accept` patterns, as an `<input accept>` does: a MIME type
 * (`application/pdf`), a wildcard (`image/*`) or an extension (`.pdf`). No `accept` (or an empty one) accepts all.
 */
export function matchesAccept(candidate: Candidate, accept: readonly string[] | undefined): boolean {
	if (!accept || accept.length === 0) return true;
	const type = candidate.type.toLowerCase();
	const name = candidate.name.toLowerCase();
	return accept.some((rawPattern) => {
		const pattern = rawPattern.trim().toLowerCase();
		if (pattern.startsWith(".")) return name.endsWith(pattern);
		if (pattern.endsWith("/*")) return type.startsWith(pattern.slice(0, -1));
		return type === pattern;
	});
}

function mediaTypeOfPattern(pattern: string): MediaType {
	const normalized = pattern.trim().toLowerCase();
	if (normalized.startsWith("image/")) return "image";
	if (normalized.startsWith("video/")) return "video";
	return "file";
}

/** The one library type every `accept` pattern maps to, or `undefined` when they span several (or there are none). */
export function mediaTypeOfAccept(accept: readonly string[] | undefined): MediaType | undefined {
	if (!accept || accept.length === 0) return undefined;
	const types = new Set(accept.map(mediaTypeOfPattern));
	if (types.size !== 1) return undefined;
	return [...types][0];
}

const ACCEPT_OF_TYPE: Record<MediaType, string[] | undefined> = {
	image: ["image/*"],
	video: ["video/*"],
	file: undefined,
};

/** The upload `accept` of a picker: its own, else the one its `type` implies. */
export function uploadAcceptOf(accept: readonly string[] | undefined, type: MediaType | undefined) {
	if (accept && accept.length > 0) return accept;
	return type ? ACCEPT_OF_TYPE[type] : undefined;
}

/** A library record passes `accept` by its filename and content type. */
export function recordMatchesAccept(record: MediaRecord, accept: readonly string[] | undefined): boolean {
	return matchesAccept({ name: record.filename, type: record.contentType }, accept);
}
