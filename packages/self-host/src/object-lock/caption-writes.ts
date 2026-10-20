// Lock checks of a captions job, kept out of the route. Every requested locale is checked before transcription
// (nothing is paid for a job whose output can't be stored): an existing locale of a locked video is refused, a new one
// is a create. Each caption is then written conditionally on what that check saw.
import type { Context } from "hono";
import { storageKey } from "../helpers";
import { expiryMetadataOf } from "../routes/upload-integrity";
import type { WorkerApp } from "../types";
import { checkWrites, deleteReplacedKey, WriteConflictError, writeConflict } from "./overwrite";

type CaptionsContext = Context<WorkerApp>;

export interface CaptionWrites {
	/** Storage key of a locale's caption. */
	storageKeyOf: (locale: string) => string;
	/** Writes a locale's caption; throws `WriteConflictError` if it changed since the check. */
	put: (locale: string, body: string | Uint8Array, options: Omit<R2PutOptions, "onlyIf">) => Promise<void>;
}

/**
 * `virtualKeyOf` maps a locale to its caption's virtual key (`{visibility}/video/{id}/captions/{locale}.vtt`).
 * `source` is the media the captions are made from: they expire with it (its `expiresAt` is copied onto each one).
 */
export async function prepareCaptionWrites(
	context: CaptionsContext,
	locales: string[],
	virtualKeyOf: (locale: string) => string,
	source: Pick<R2Object, "customMetadata">,
): Promise<{ blocked: Response } | CaptionWrites> {
	const writes = await checkWrites(context, locales.map(virtualKeyOf));
	if ("blocked" in writes) return writes;
	const storageKeyOf = (locale: string) => storageKey(context, virtualKeyOf(locale));
	const expiry = expiryMetadataOf(source.customMetadata);
	return {
		storageKeyOf,
		put: async (locale, body, options) => {
			const check = writes.checks.get(virtualKeyOf(locale));
			const customMetadata = { ...options.customMetadata, ...expiry };
			const stored = await context.env.MEDIA_BUCKET.put(storageKeyOf(locale), body, {
				...options,
				...(Object.keys(customMetadata).length > 0 ? { customMetadata } : {}),
				onlyIf: check?.onlyIf,
			});
			if (stored === null) throw new WriteConflictError(virtualKeyOf(locale));
			await deleteReplacedKey(context, storageKeyOf(locale), check?.replacedEnc);
		},
	};
}

/** The response for a job that failed because a caption changed under it, or null for any other failure. */
export function captionConflictResponse(context: CaptionsContext, error: unknown): Response | null {
	return error instanceof WriteConflictError ? writeConflict(context, error.key) : null;
}
