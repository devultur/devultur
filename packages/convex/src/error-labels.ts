// Messages for Devultur errors, keyed by their stable `code`. English here; `@devultur/convex/locales/es` has Spanish.
// Pass any subset to `describeDevulturError` to override some messages, or a full map to translate them all.
import type { DevulturErrorCode } from "./error-codes";
import { isDevulturErrorCode } from "./error-codes";
import { devulturErrorOf } from "./errors";

/** The error's extra fields: the Worker's (`limit`, `key`, `until`, ...) and its HTTP `status`. */
export type DevulturErrorDetails = Readonly<Record<string, unknown>> & { status?: number };

export type DevulturErrorLabel = string | ((details: DevulturErrorDetails) => string);

export type DevulturErrorLabels = Record<DevulturErrorCode, DevulturErrorLabel>;

/** A label's text for `details` (default none): a string as is, a function called with them. */
export function labelText(label: DevulturErrorLabel, details: DevulturErrorDetails = {}): string {
	return typeof label === "function" ? label(details) : label;
}

/** `bytes` as `25 MB` / `800 kB` in `locale`. */
export function formatBytes(bytes: number, locale: string): string {
	const isMegabytes = bytes >= 1_000_000;
	const amount = isMegabytes ? bytes / 1_000_000 : bytes / 1_000;
	const unit = isMegabytes ? "megabyte" : "kilobyte";
	return new Intl.NumberFormat(locale, { style: "unit", unit, maximumFractionDigits: 1 }).format(amount);
}

/** `value` as a date in `locale`, or `null` when it isn't one. */
export function formatDate(value: unknown, locale: string): string | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

function sizeLimit(details: DevulturErrorDetails, locale: string): string | null {
	return typeof details.limit === "number" ? formatBytes(details.limit, locale) : null;
}

export const devulturErrorLabels: DevulturErrorLabels = {
	file_too_large: (details) => {
		const limit = sizeLimit(details, "en");
		return limit ? `The file exceeds the maximum size (${limit}).` : "The file exceeds the maximum size.";
	},
	content_type_not_allowed: "This file type isn't allowed.",
	content_type_mismatch: "The file's content doesn't match its type.",
	content_unverified: "The upload couldn't be verified. Try again.",
	unsupported_content_type: "This file type isn't supported.",
	media_type_mismatch: "The file type doesn't match the kind of media expected.",
	already_exists: "A file with this name already exists.",
	write_conflict: "The file changed while it was being saved. Try again.",
	upload_not_found: "The upload wasn't found or has expired. Start it again.",
	invalid_upload_key: "This isn't a valid upload.",
	invalid_path: "The file path isn't valid.",
	path_required: "This upload needs a file path.",
	invalid_expires_in: "The expiration time isn't valid.",
	invalid_file_expires_in: "The file's expiration time isn't valid.",
	invalid_cache_control: "The cache setting isn't valid.",
	invalid_limits: "The upload limits aren't valid.",
	invalid_prefix: "The folder isn't valid.",
	invalid_visibility: "The visibility must be public or private.",
	invalid_cursor: "The page of results isn't valid. Reload the list.",
	invalid_sha256: "The file's checksum isn't valid.",
	sha256_mismatch: "The file was corrupted during the upload. Try again.",
	max_files_reached: "You've reached the maximum number of files for this upload.",
	invalid_multipart: "The upload request isn't valid.",
	invalid_size: "The file size isn't valid.",
	invalid_part: "Part of the upload isn't valid. Try again.",
	invalid_parts: "The upload is incomplete. Try again.",
	invalid_media_metadata: (details) => {
		if (details.field === "title") return "The title can't be longer than 200 characters.";
		if (details.field === "alt") return "The alternative text can't be longer than 1,000 characters.";
		if (details.field === "tags") return "Use at most 20 tags, of up to 50 characters each.";
		return "The file's details aren't valid.";
	},
	part_size_mismatch: "Part of the upload has the wrong size. Try again.",
	part_sha256_required: "Part of the upload is missing its checksum.",
	expired: "This file has expired.",
	invalid_key: "This file reference isn't valid.",
	invalid_max_uses: "The number of uses isn't valid.",
	link_exists: "This download link already exists.",
	link_not_found: "This download link doesn't exist.",
	link_expired: "This download link has expired.",
	link_used: "This download link was already used.",
	not_configured: "This feature isn't set up.",
	retention_active: (details) => {
		if (details.hold === true) return "This file is on hold and can't be changed or deleted.";
		const until = formatDate(details.until, "en");
		return until
			? `This file is retained until ${until} and can't be changed or deleted before then.`
			: "This file is retained and can't be changed or deleted.";
	},
	lock_conflict: "The file's lock changed meanwhile. Try again.",
	compliance_extend_only: "This file's retention can only be extended.",
	lock_privilege_required: "You don't have permission to shorten or remove this file's retention.",
	lock_record_unreadable: "The file's retention couldn't be read.",
	lock_below_minimum: "This upload requires a stricter retention.",
	invalid_lock: "The retention settings aren't valid.",
	invalid_hold: "The hold setting isn't valid.",
	reserved_key: "This file name is reserved.",
	keys_bucket_missing: "Files can't be stored securely right now.",
	encryption_key_missing: "This file can no longer be read. Upload it again.",
	unauthorized: "You aren't authorized to do this.",
	session_mismatch: "Your session changed. Reload the page.",
	token_rejected: "Access was denied.",
	reserved_user_id: "This user ID is reserved.",
	invalid_scopes: "The requested permissions aren't valid.",
	user_mismatch: "You can only see and change your own progress.",
	transcode_not_configured: "Video processing isn't set up.",
	transcode_runner_unavailable: "Video processing is busy right now. Try again later.",
	transcode_launch_failed: "The video couldn't be processed.",
	original_not_retained: "The original video is no longer available, so it can't be processed again. Upload it again.",
	locale_not_allowed: "Captions aren't available in this language.",
	captions_provider_rate_limited: "Captions are busy right now. Try again later.",
	captions_provider_error: "The captions couldn't be generated.",
	captions_failed: "The captions couldn't be generated.",
	webhook_secret_missing: "Video processing isn't set up.",
	worker_auth_secret_missing: "The media service isn't set up.",
	worker_error: "The media service couldn't complete the request.",
	http_error: "The file couldn't be loaded.",
	too_large: "The file is too large to preview.",
	unsupported_type: "This file type can't be previewed.",
	type_mismatch: "The file's content doesn't match its type.",
	token_unavailable: "Access to this file couldn't be granted. Try again.",
	page_cap: (details) => {
		const { shown, total } = details;
		if (typeof shown !== "number" || typeof total !== "number") return "Only the first pages are shown.";
		return `Only the first ${shown.toLocaleString("en")} of ${total.toLocaleString("en")} pages are shown.`;
	},
	render_failed: "The file couldn't be displayed.",
	capability_unavailable: "This app can't do that here.",
};

interface ErrorDescriptor {
	code: string;
	details: DevulturErrorDetails;
}

type CodedError = Error & { code?: unknown; status?: unknown; details?: unknown; limit?: unknown };

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

// `MediaFetchError`, `DevulturCapabilityError` and `@devultur/core`'s `DevulturApiError`, matched by name: a second bundled copy fails instanceof.
function codedErrorOf(error: unknown): ErrorDescriptor | null {
	if (!(error instanceof Error)) return null;
	const { code, status, details, limit } = error as CodedError;
	const statusField = typeof status === "number" ? { status } : {};
	if (error.name === "MediaFetchError" && typeof code === "string") {
		return { code, details: { ...asRecord(details), ...statusField } };
	}
	if (error.name === "DevulturCapabilityError") return { code: "capability_unavailable", details: {} };
	if (error.name !== "DevulturApiError") return null;
	const limitField = typeof limit === "number" ? { limit } : {};
	return {
		code: typeof code === "string" ? code : "worker_error",
		details: { ...asRecord(details), ...limitField, ...statusField },
	};
}

function descriptorOf(error: unknown): ErrorDescriptor | null {
	const refusal = devulturErrorOf(error);
	if (!refusal) return codedErrorOf(error);
	return { code: refusal.code, details: { ...refusal.details, status: refusal.status } };
}

/**
 * The message for a Devultur error (a component action's refusal, a `DevulturApiError` or a `MediaFetchError`), from
 * `labels` over the English defaults. An unknown code gets `worker_error`'s message. `null` when `error` isn't one.
 */
export function describeDevulturError(error: unknown, labels?: Partial<DevulturErrorLabels>): string | null {
	const descriptor = descriptorOf(error);
	if (!descriptor) return null;
	const code: DevulturErrorCode = isDevulturErrorCode(descriptor.code) ? descriptor.code : "worker_error";
	return labelText(labels?.[code] ?? devulturErrorLabels[code], descriptor.details);
}
