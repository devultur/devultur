import type { DevulturMedia } from "@devultur/core";
import { expectedContentType, previewKindOf } from "./preview-type";

/** What an attachment is, for its icon and type label. */
export type AttachmentKind = "image" | "video" | "pdf" | "audio" | "text" | "file";

/**
 * Every string `<AttachmentCard>` and `<DocumentLink>` show or announce. Pass any subset as `labels`; the rest keep
 * the English defaults (`defaultAttachmentLabels`). Spanish: `attachmentLabels` from `@devultur/convex/locales/es`.
 */
export interface AttachmentLabels {
	/** BCP 47 locale passed to `size`. A component's `locale` prop wins over it. */
	locale: string;
	/** A file size, e.g. `1.5 MB`. */
	size: (bytes: number, locale: string) => string;
	/** A PDF's page count, e.g. `12 pages`. */
	pages: (pageCount: number) => string;
	/** An audio or video duration, e.g. `1:05`. */
	duration: (seconds: number) => string;
	/** The type shown next to the size, e.g. `PDF`. */
	kind: (kind: AttachmentKind) => string;
	/** Text of the download action. */
	download: string;
	/** Text of the open-preview action. */
	open: string;
	/** Name of a media with no `title` and no filename. */
	untitled: string;
}

const KIND_TEXT: Record<AttachmentKind, string> = {
	image: "Image",
	video: "Video",
	pdf: "PDF",
	audio: "Audio",
	text: "Text",
	file: "File",
};

const SIZE_UNITS = [
	{ unit: "gigabyte", bytes: 1e9 },
	{ unit: "megabyte", bytes: 1e6 },
	{ unit: "kilobyte", bytes: 1e3 },
] as const;

/** `bytes` in decimal units (`1.5 MB`), formatted for `locale`. Under 1 kB, whole bytes (`512 bytes`). */
export function formatFileSize(bytes: number, locale: string): string {
	const scale = SIZE_UNITS.find((candidate) => bytes >= candidate.bytes);
	if (!scale) return new Intl.NumberFormat(locale, { style: "unit", unit: "byte", unitDisplay: "long" }).format(bytes);
	const amount = bytes / scale.bytes;
	return new Intl.NumberFormat(locale, { style: "unit", unit: scale.unit, maximumFractionDigits: 1 }).format(amount);
}

/** `seconds` as a clock: `0:42`, `1:05`, `1:02:03`. */
export function formatDuration(seconds: number): string {
	const totalSeconds = Math.max(0, Math.round(seconds));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const remainder = String(totalSeconds % 60).padStart(2, "0");
	if (hours === 0) return `${minutes}:${remainder}`;
	return `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`;
}

export const defaultAttachmentLabels: AttachmentLabels = {
	locale: "en",
	size: formatFileSize,
	pages: (pageCount) => (pageCount === 1 ? "1 page" : `${pageCount.toLocaleString("en")} pages`),
	duration: formatDuration,
	kind: (kind) => KIND_TEXT[kind],
	download: "Download",
	open: "Open preview",
	untitled: "Untitled file",
};

/** The English defaults, overridden by `labels`; a key set to `undefined` keeps the default. */
export function mergeAttachmentLabels(labels?: Partial<AttachmentLabels>): AttachmentLabels {
	const definedEntries = Object.entries(labels ?? {}).filter(([, value]) => value !== undefined);
	return { ...defaultAttachmentLabels, ...Object.fromEntries(definedEntries) };
}

/** A media's display name: its `title`, else its filename, else `untitled`. */
export function attachmentName(media: DevulturMedia, untitled: string): string {
	return media.title?.trim() || media.filename || untitled;
}

/** What a media is: its kind for images and videos, else what its content type (or filename) says. */
export function attachmentKindOf(media: DevulturMedia, contentType?: string): AttachmentKind {
	if (media.kind !== "file") return media.kind;
	const previewKind = previewKindOf(expectedContentType(media, contentType));
	return previewKind ?? "file";
}

/** The details line of a card: type, size, and page count (PDF) or duration (audio, video), when known. */
export function attachmentDetails(
	media: DevulturMedia,
	kind: AttachmentKind,
	labels: AttachmentLabels,
	locale: string,
) {
	const details = [labels.kind(kind)];
	if (media.sizeBytes !== undefined) details.push(labels.size(media.sizeBytes, locale));
	if (kind === "pdf" && media.pageCount !== undefined) details.push(labels.pages(media.pageCount));
	const hasDuration = kind === "audio" || kind === "video";
	if (hasDuration && media.duration !== undefined) details.push(labels.duration(media.duration));
	return details;
}
