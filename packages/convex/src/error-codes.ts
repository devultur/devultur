// Every stable error `code` an app can get from Devultur: the media Worker's refusals (they reach the app as a
// `ConvexError<DevulturErrorData>` from component actions, or a `DevulturApiError` from `@devultur/core`), the
// component's own, and `MediaFetchError`'s. `test/error-codes.test.ts` fails when the Worker gains a code missing here.

export const DEVULTUR_ERROR_CODES = [
	// Uploads
	"file_too_large",
	"content_type_not_allowed",
	"content_type_mismatch",
	"content_unverified",
	"unsupported_content_type",
	"media_type_mismatch",
	"already_exists",
	"write_conflict",
	"upload_not_found",
	"invalid_upload_key",
	"invalid_path",
	"path_required",
	"invalid_expires_in",
	"invalid_file_expires_in",
	"invalid_cache_control",
	"invalid_limits",
	"invalid_prefix",
	"invalid_visibility",
	"invalid_cursor",
	"invalid_sha256",
	"sha256_mismatch",
	"max_files_reached",
	"invalid_multipart",
	"invalid_size",
	"invalid_part",
	"invalid_parts",
	"part_size_mismatch",
	"part_sha256_required",
	// Media metadata (`updateMediaMeta`, `confirmUpload`'s hints)
	"invalid_media_metadata",
	// Delivery and download links
	"expired",
	"invalid_key",
	"invalid_max_uses",
	"link_exists",
	"link_not_found",
	"link_expired",
	"link_used",
	"not_configured",
	// Retention and holds
	"retention_active",
	"lock_conflict",
	"compliance_extend_only",
	"lock_privilege_required",
	"lock_record_unreadable",
	"lock_below_minimum",
	"invalid_lock",
	"invalid_hold",
	"reserved_key",
	// Encryption at rest
	"keys_bucket_missing",
	"encryption_key_missing",
	// Tokens and sessions
	"unauthorized",
	"session_mismatch",
	"token_rejected",
	"reserved_user_id",
	"invalid_scopes",
	// Video and captions
	"transcode_not_configured",
	"transcode_runner_unavailable",
	"transcode_launch_failed",
	"original_not_retained",
	"locale_not_allowed",
	"captions_provider_rate_limited",
	"captions_provider_error",
	"captions_failed",
	// Worker configuration
	"webhook_secret_missing",
	"worker_auth_secret_missing",
	// A Worker refusal without a code
	"worker_error",
	// `MediaFetchError` (previews, downloads, object URLs)
	"http_error",
	"too_large",
	"unsupported_type",
	"type_mismatch",
	"token_unavailable",
	// `DevulturCapabilityError` (an action the provider wasn't given)
	"capability_unavailable",
] as const;

/** A stable error code: match on it, not on `message`. */
export type DevulturErrorCode = (typeof DEVULTUR_ERROR_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(DEVULTUR_ERROR_CODES);

export function isDevulturErrorCode(code: unknown): code is DevulturErrorCode {
	return typeof code === "string" && KNOWN_CODES.has(code);
}
