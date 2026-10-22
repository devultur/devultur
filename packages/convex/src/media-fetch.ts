// Delivery fetch shared by `<Image>`, `<DownloadLink>`, `useMediaObjectUrl` and `<Preview>`. A native `<img src>`, a
// navigation or an `<iframe src>` can't send `${SESSION_HEADER}`, so private media is fetched here with the header and
// handed to the element as an object URL. A 401 `session_mismatch` re-issues the viewer token once and retries.
import { SESSION_HEADER } from "@devultur/core";
import { isSessionMismatch } from "./image-recovery";
import { trustedContentType } from "./preview-type";

/** Why a media fetch was refused. Stable: match on it, not on `message`. */
export type MediaFetchErrorCode =
	/** The delivery answered with a non-2xx status (`status` has it). */
	| "http_error"
	/** `Content-Length`, or the streamed body, exceeds `maxBytes`. */
	| "too_large"
	/** The expected content type isn't one that can be previewed inline. */
	| "unsupported_type"
	/** The response's `Content-Type` doesn't agree with the expected one. */
	| "type_mismatch"
	/** No viewer token for private media: its issuance failed (`useDevultur().tokenError` has why) or was refused. */
	| "token_unavailable"
	/** The delivery refused the token for this browser session, also after a re-issue (video playback). */
	| "session_mismatch";

export class MediaFetchError extends Error {
	readonly code: MediaFetchErrorCode;
	/** HTTP status, for `http_error`. */
	readonly status?: number;

	constructor(code: MediaFetchErrorCode, message: string, status?: number, options?: ErrorOptions) {
		super(message, options);
		this.name = "MediaFetchError";
		this.code = code;
		this.status = status;
	}
}

/** Private media can't be fetched: the viewer token couldn't be issued (`cause`: the issuance's error). */
export function tokenUnavailableError(cause?: Error | null): MediaFetchError {
	return new MediaFetchError("token_unavailable", "No viewer token: its issuance failed", undefined, { cause });
}

export interface MediaFetchRequest {
	/** Delivery URL for a viewer token (`undefined` → no token). */
	buildUrl: (viewerToken: string | undefined) => string;
	token: string | null;
	sessionSecret: string;
	reissueToken: () => Promise<string | null>;
	/** Public delivery sends no token and no header, and never re-issues. Default `true`. */
	isPrivate?: boolean;
	/** `false` → a 401 is returned as is (the caller already re-issued for this media). Default `true`. */
	canReissue?: boolean;
	/** Called right before the re-issue. */
	onReissue?: () => void;
	signal?: AbortSignal;
}

/** Fetches a delivery URL; a private 401 `session_mismatch` re-issues the token once and retries with the fresh one. */
export async function fetchMedia(request: MediaFetchRequest): Promise<Response> {
	const { buildUrl, token, sessionSecret, reissueToken, signal, isPrivate = true, canReissue = true } = request;
	const headers = isPrivate && sessionSecret ? { [SESSION_HEADER]: sessionSecret } : undefined;
	const response = await fetch(buildUrl(isPrivate ? (token ?? undefined) : undefined), { headers, signal });
	if (!isPrivate || !canReissue || response.status !== 401) return response;
	if (!(await isSessionMismatch(response))) return response;

	request.onReissue?.();
	const freshToken = await reissueToken();
	if (!freshToken) return response;
	return fetch(buildUrl(freshToken), { headers, signal });
}

export interface LoadedMedia {
	bytes: Uint8Array<ArrayBuffer>;
	/** The type the bytes may be trusted with (see `trustedContentType`), never the response's verbatim. */
	contentType: string;
}

/**
 * Fetches a media body, checking its type before reading it and its size while reading it.
 * `contentType` is the type the caller expects; without it, the response's type is kept only if allowlisted.
 */
export async function loadMedia(
	request: MediaFetchRequest & { maxBytes?: number; contentType?: string },
): Promise<LoadedMedia> {
	const response = await fetchMedia(request);
	if (!response.ok) {
		throw new MediaFetchError("http_error", `Media fetch failed: ${response.status}`, response.status);
	}
	const trusted = trustedContentType(request.contentType, response.headers.get("content-type"));
	if (!trusted.ok) {
		await response.body?.cancel();
		throw new MediaFetchError(trusted.reason, `Refusing to preview: ${trusted.reason}`);
	}
	const bytes = await readMediaBody(response, request.maxBytes);
	return { bytes, contentType: trusted.contentType };
}

function tooLarge(maxBytes: number): MediaFetchError {
	return new MediaFetchError("too_large", `Media is larger than ${maxBytes} bytes`);
}

/** Reads the body, refusing it up front when `Content-Length` exceeds `maxBytes` and mid-stream when the bytes do. */
export async function readMediaBody(response: Response, maxBytes?: number): Promise<Uint8Array<ArrayBuffer>> {
	if (maxBytes === undefined) return new Uint8Array(await response.arrayBuffer());
	const declaredBytes = Number(response.headers.get("content-length") ?? Number.NaN);
	if (declaredBytes > maxBytes) {
		await response.body?.cancel();
		throw tooLarge(maxBytes);
	}
	if (!response.body) return new Uint8Array(0);
	return readCapped(response.body, maxBytes);
}

// `Content-Length` can be missing or wrong (compressed or chunked responses), so the cap also holds while streaming.
async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let byteCount = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		byteCount += value.byteLength;
		if (byteCount > maxBytes) {
			await reader.cancel();
			throw tooLarge(maxBytes);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(byteCount);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
