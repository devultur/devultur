import type { ObjectLock, VideoModuleConfig } from "@devultur/core";
import type { Infer } from "convex/values";
import type schema from "./component/schema";

export interface DevulturComponentConfig {
	video?: VideoModuleConfig;
	/**
	 * Lock every upload through the exposed `createUploadUrl` gets (retention and/or hold). Set here, on your server:
	 * the browser never chooses a lock. To lock per upload, call `devultur.createUploadUrl(ctx, { lock })` from your
	 * own function.
	 */
	upload?: { lock?: ObjectLock };
}

/**
 * A media record as the component stores it (without the system fields), inferred from the schema's `media` table so
 * it has every field the component writes: the transcode's progress phase, outputs (`renditions`, `posterUrls`,
 * `hasAudio`) and failure (`failureReason`, `retriable`), the metadata, the upload hints. The schema documents each.
 */
export type MediaRecord = Infer<typeof schema.tables.media.validator>;

export interface ProgressRecord {
	userId: string;
	videoId: string;
	lastPosition: number;
	completedAt?: number;
	watchedPercent?: number;
	updatedAt: number;
}
