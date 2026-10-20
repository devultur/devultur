// Lock checks of a captions job, kept out of the route. Every requested locale is checked before transcription
// (nothing is paid for a job whose output can't be stored): an existing locale of a locked video is refused, a new one
// is a create. Each caption is then written conditionally on what that check saw.
import type { Context } from "hono";
import { storageKey } from "../helpers";
import type { WorkerApp } from "../types";
import { checkWrites, WriteConflictError, writeConflict } from "./overwrite";

type CaptionsContext = Context<WorkerApp>;

export interface CaptionWrites {
	/** Storage key of a locale's caption. */
	storageKeyOf: (locale: string) => string;
	/** Writes a locale's caption; throws `WriteConflictError` if it changed since the check. */
	put: (locale: string, body: string | Uint8Array, options: Omit<R2PutOptions, "onlyIf">) => Promise<void>;
}

/** `virtualKeyOf` maps a locale to its caption's virtual key (`{visibility}/video/{id}/captions/{locale}.vtt`). */
export async function prepareCaptionWrites(
	context: CaptionsContext,
	locales: string[],
	virtualKeyOf: (locale: string) => string,
): Promise<{ blocked: Response } | CaptionWrites> {
	const writes = await checkWrites(context, locales.map(virtualKeyOf));
	if ("blocked" in writes) return writes;
	const storageKeyOf = (locale: string) => storageKey(context, virtualKeyOf(locale));
	return {
		storageKeyOf,
		put: async (locale, body, options) => {
			const onlyIf = writes.conditions.get(virtualKeyOf(locale));
			const stored = await context.env.MEDIA_BUCKET.put(storageKeyOf(locale), body, { ...options, onlyIf });
			if (stored === null) throw new WriteConflictError(virtualKeyOf(locale));
		},
	};
}

/** The response for a job that failed because a caption changed under it, or null for any other failure. */
export function captionConflictResponse(context: CaptionsContext, error: unknown): Response | null {
	return error instanceof WriteConflictError ? writeConflict(context, error.key) : null;
}
