// `uploadLargeFile`: uploads a file from disk (several GB, from CI) to `asset/{prefix}{name}` in parallel parts, with
// the file's sha256 computed in streaming (bounded memory) and declared to the worker, and each part verified against
// its own. Node ≥ 20 (uses `fs.openAsBlob`: the file is read in parts, not whole). Node modules are imported
// inside the function so `@devultur/server` keeps loading in edge runtimes.
import { type AssetUploadResult, createWorkerClient, type Visibility } from "@devultur/core";

export interface UploadLargeFileOptions {
	/** Prefix inside `asset/` (`exports/inst-1/`). */
	prefix: string;
	/** File name in the prefix. Default: the local file's basename. */
	name?: string;
	/** TTL in seconds (with an upload token, at most the token's own). */
	expiresIn?: number;
	/** Upload token or the worker's credential. Default: `DEVULTUR_UPLOAD_TOKEN` or `DEVULTUR_SECRET`. */
	credential?: string;
	/** Worker origin (`https://media.example.com`). */
	baseUrl: string;
	contentType?: string;
	overwrite?: boolean;
	visibility?: Visibility;
	/** `Cache-Control`: preset (`immutable` | `revalidate` | `no-cache`) or a string validated by the worker. */
	cacheControl?: string;
	/** Already-computed sha256 hex (e.g. from a sync script): used instead of reading the file again. */
	sha256?: string;
	/** Parts in flight at once (default 4). */
	concurrency?: number;
	onProgress?: (percent: number) => void;
	signal?: AbortSignal;
}

export interface LargeFileUploadResult extends AssetUploadResult {
	/** sha256 computed locally (the one declared to the worker). */
	sha256: string;
}

async function sha256OfFile(filePath: string): Promise<string> {
	const { createHash } = await import("node:crypto");
	const { createReadStream } = await import("node:fs");
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

function resolveCredential(explicit: string | undefined): string {
	const credential = explicit ?? process.env.DEVULTUR_UPLOAD_TOKEN ?? process.env.DEVULTUR_SECRET;
	if (!credential) throw new Error("uploadLargeFile needs a credential (DEVULTUR_UPLOAD_TOKEN or DEVULTUR_SECRET)");
	return credential;
}

export async function uploadLargeFile(
	filePath: string,
	options: UploadLargeFileOptions,
): Promise<LargeFileUploadResult> {
	const { openAsBlob } = await import("node:fs");
	const { basename } = await import("node:path");
	const credential = resolveCredential(options.credential);
	const prefix = options.prefix.endsWith("/") ? options.prefix : `${options.prefix}/`;
	const sha256 = options.sha256 ?? (await sha256OfFile(filePath));
	const file = await openAsBlob(filePath, { type: options.contentType ?? "application/octet-stream" });

	const client = createWorkerClient(credential, options.baseUrl);
	const result = await client.uploads.uploadAsset(file, {
		path: `${prefix}${options.name ?? basename(filePath)}`,
		contentType: options.contentType,
		sha256,
		expiresIn: options.expiresIn,
		overwrite: options.overwrite,
		visibility: options.visibility,
		cacheControl: options.cacheControl,
		concurrency: options.concurrency,
		onProgress: options.onProgress,
		signal: options.signal,
	});
	if (result.sha256 && result.sha256 !== sha256) {
		throw new Error(`sha256 mismatch for ${result.key}: local ${sha256}, stored ${result.sha256}`);
	}
	return { ...result, sha256 };
}
