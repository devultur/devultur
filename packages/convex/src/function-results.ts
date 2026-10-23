// What each function `defineDevulturFunctions` and `Devultur.exposeApi` register returns: the component's own results,
// as an app receives them. `component/_generated/component.ts` types every result `any` (the component's functions
// declare no `returns` validators), so these are written out here, and `function-results.test.ts` checks them against
// the component's handlers.
import type { DeleteVideoResult, TranscodeJobResult, WorkerUploadResult } from "@devultur/core";
import type { PaginationResult } from "convex/server";
import type { MediaRecord, ProgressRecord } from "./types";

/** Convex's system fields on a document a component returns. Its `_id` is a plain string in your app. */
export interface ComponentSystemFields {
	_id: string;
	_creationTime: number;
}

/** A media record as the component's functions return it: the stored fields and the system fields. */
export interface MediaDocument extends MediaRecord, ComponentSystemFields {}

/** A watch-progress record as the component's functions return it. */
export interface ProgressDocument extends ProgressRecord, ComponentSystemFields {}

/** The result of each exposed function, by name. */
export interface DevulturFunctionResults {
	issueViewerToken: { token: string; expiresIn: number };
	createUploadUrl: WorkerUploadResult;
	/** The record, or `null` when nothing is stored at the key. */
	confirmUpload: MediaDocument | null;
	/** The updated record, or `null` when there is none. */
	updateMediaMeta: MediaDocument | null;
	deleteMedia: null;
	deleteVideo: DeleteVideoResult;
	processVideo: TranscodeJobResult;
	getMedia: MediaDocument | null;
	listMediaPage: PaginationResult<MediaDocument>;
	searchMedia: PaginationResult<MediaDocument>;
	/** The progress record's id. */
	saveProgress: string;
	loadProgress: ProgressDocument | null;
	/** The progress record's id. */
	markComplete: string;
	resetProgress: null;
}
