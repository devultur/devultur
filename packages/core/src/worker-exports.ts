// `client.uploads` and `client.files`: private exports (multi-GB files generated in CI). An upload token
// scoped to a prefix for the runner, multipart upload with sha256, `head` to verify before publishing, single-use
// download links, and server-side streaming without exposing credentials.
import { errorFromResponse } from "./api-error";
import { EXPIRES_AT_HEADER, SHA256_HEADER, SHA256_VERIFIED_HEADER } from "./integrity";
import type { ObjectLock } from "./lock";
import type { Visibility } from "./media";
import { type CapabilityUploadResult, shouldUseMultipart, uploadMultipart } from "./multipart";

export interface CreateUploadTokenOptions {
	/** Prefix within `asset/` where the token can create files (`exports/inst-1/`). */
	prefix: string;
	/** Token lifetime in seconds (default 3600, max 86400). */
	expiresIn?: number;
	/** Cap per file (bytes). */
	maxBytes?: number;
	/** Files the token can create (best-effort). */
	maxFiles?: number;
	/** TTL (seconds) of each file uploaded with the token: it's deleted on its own once it expires. */
	fileExpiresIn?: number;
	/** Visibility of the token's files (default `private`). */
	visibility?: Visibility;
	/** Minimum lock of every file uploaded with the token: an upload can make it stricter, never looser. */
	lock?: ObjectLock;
}

export interface UploadToken {
	token: string;
	/** Normalized prefix within `asset/` (with a trailing `/`). */
	prefix: string;
	visibility: Visibility;
	/** Token expiration (epoch seconds). */
	expiresAt: number;
	maxBytes?: number;
	maxFiles?: number;
	fileExpiresIn?: number;
}

export interface UploadAssetOptions {
	/** Path within `asset/` (`exports/inst-1/pkg.zip`). */
	path: string;
	contentType?: string;
	/** sha256 hex of the file. Single PUT: the worker verifies it. Multipart: declared by the client (see docs). */
	sha256?: string;
	/** File TTL in seconds (with an upload token, capped at the token's own). */
	expiresIn?: number;
	/** Overwrite if it already exists (default false → 409 `already_exists`). */
	overwrite?: boolean;
	visibility?: Visibility;
	/**
	 * `Cache-Control` of the file: preset (`immutable` | `revalidate` | `no-cache`) or a validated string. Absent → the
	 * config's per-prefix rule, or `public, max-age=60, stale-while-revalidate=86400`.
	 */
	cacheControl?: string;
	/** Lock of the file (retention and/or hold), written with its bytes. */
	lock?: ObjectLock;
	/** Shorthand for `lock.hold`. */
	hold?: boolean;
	/** Parts in flight at once in a multipart upload (default 4). */
	concurrency?: number;
	onProgress?: (percent: number) => void;
	signal?: AbortSignal;
}

export interface AssetUploadResult {
	key: string;
	size: number;
	sha256?: string;
	sha256Verified?: boolean;
	expiresAt?: number;
}

interface CreatedAssetUpload {
	key: string;
	uploadUrl: string;
	expiresAt?: number;
}

export interface FileHead {
	key: string;
	size: number;
	contentType: string;
	etag: string | null;
	sha256: string | null;
	/** `true`: the worker computed the sha256 over the bytes. `false`: declared by the client (multipart). */
	sha256Verified: boolean;
	/** Expiration (epoch ms) if the file has a TTL. */
	expiresAt: number | null;
}

export interface DownloadLinkOptions {
	/** Link lifetime in seconds (default 900, max 7 days). */
	expiresIn?: number;
	/** Allowed redemptions (default 1). Each request to the link counts as one. */
	maxUses?: number;
	/** File name in the `Content-Disposition: attachment`. */
	filename?: string;
}

export interface DownloadLink {
	url: string;
	expiresAt: number;
	maxUses: number;
}

export interface UploadsClient {
	/** Upload token scoped to a prefix. Pass it to the CI runner instead of the credential. */
	createToken(options: CreateUploadTokenOptions): Promise<UploadToken>;
	/** Uploads a file to `asset/{path}` (multipart if large). Works with the worker's credential or an upload token. */
	uploadAsset(file: Blob, options: UploadAssetOptions): Promise<AssetUploadResult>;
}

export interface FilesClient {
	/** Size, sha256 and expiration. `null` if it doesn't exist. */
	head(key: string): Promise<FileHead | null>;
	/** Single-use download link: the link doesn't carry the credential. */
	createDownloadLink(key: string, options?: DownloadLinkOptions): Promise<DownloadLink>;
	/** `Response` of the file to pipe from your backend to your user (without exposing a token). */
	stream(key: string, options?: { range?: string; signal?: AbortSignal }): Promise<Response>;
	delete(key: string): Promise<void>;
}

type FetchApi = (path: string, init?: RequestInit) => Promise<Response>;
type JsonRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

const ASSET_PART_CONCURRENCY = 4;

function encodeKey(key: string): string {
	return key.split("/").map(encodeURIComponent).join("/");
}

function headFromResponse(key: string, response: Response): FileHead {
	const expiresAt = Number(response.headers.get(EXPIRES_AT_HEADER));
	return {
		key,
		size: Number(response.headers.get("content-length") ?? "0"),
		contentType: response.headers.get("content-type") ?? "application/octet-stream",
		etag: response.headers.get("etag"),
		sha256: response.headers.get(SHA256_HEADER),
		sha256Verified: response.headers.get(SHA256_VERIFIED_HEADER) === "true",
		expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
	};
}

async function putSingle(uploadUrl: string, file: Blob, options: UploadAssetOptions): Promise<CapabilityUploadResult> {
	const response = await fetch(uploadUrl, {
		method: "PUT",
		body: file,
		headers: {
			"Content-Type": options.contentType ?? (file.type || "application/octet-stream"),
			...(options.sha256 ? { [SHA256_HEADER]: options.sha256 } : {}),
		},
		signal: options.signal,
	});
	if (!response.ok) throw await errorFromResponse(response);
	options.onProgress?.(100);
	return (await response.json()) as CapabilityUploadResult;
}

export function createUploadsClient(base: string, request: JsonRequest): UploadsClient {
	return {
		createToken(options) {
			return request<UploadToken>("/v1/token/upload", { method: "POST", body: JSON.stringify(options) });
		},

		async uploadAsset(file, options) {
			const created = await request<CreatedAssetUpload>("/v1/upload", {
				method: "POST",
				body: JSON.stringify({
					path: options.path,
					filename: options.path.split("/").pop(),
					contentType: options.contentType ?? (file.type || "application/octet-stream"),
					size: file.size,
					sha256: options.sha256,
					expiresIn: options.expiresIn,
					overwrite: options.overwrite,
					visibility: options.visibility,
					cacheControl: options.cacheControl,
					lock: options.lock,
					hold: options.hold,
				}),
			});
			const uploadUrl = `${base}${created.uploadUrl}`;
			const result = shouldUseMultipart(uploadUrl, file.size)
				? await uploadMultipart(uploadUrl, file, {
						sha256: options.sha256,
						checksumParts: true,
						concurrency: options.concurrency ?? ASSET_PART_CONCURRENCY,
						onProgress: options.onProgress,
						signal: options.signal,
					})
				: await putSingle(uploadUrl, file, options);
			return { ...result, key: created.key, ...(created.expiresAt ? { expiresAt: created.expiresAt } : {}) };
		},
	};
}

export function createFilesClient(fetchApi: FetchApi, request: JsonRequest): FilesClient {
	return {
		async head(key) {
			try {
				const response = await fetchApi(`/v1/media/${encodeKey(key)}`, { method: "HEAD" });
				return headFromResponse(key, response);
			} catch (error) {
				if ((error as { status?: number }).status === 404) return null;
				throw error;
			}
		},

		createDownloadLink(key, options = {}) {
			return request<DownloadLink>("/v1/token/download", {
				method: "POST",
				body: JSON.stringify({ key, ...options }),
			});
		},

		stream(key, options = {}) {
			return fetchApi(`/v1/media/${encodeKey(key)}`, {
				headers: options.range ? { Range: options.range } : {},
				signal: options.signal,
			});
		},

		async delete(key) {
			await fetchApi(`/v1/media/${encodeKey(key)}`, { method: "DELETE" });
		},
	};
}
