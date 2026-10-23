import type { ObjectLock, VideoModuleConfig, Visibility } from "@devultur/core";
import type { Infer } from "convex/values";
import type schema from "./component/schema";

export interface DevulturComponentConfig {
	video?: VideoModuleConfig;
	upload?: DevulturUploadConfig;
}

/** How the exposed `createUploadUrl` uploads. */
export interface DevulturUploadConfig {
	/**
	 * Lock every upload gets (retention and/or hold). Set here, on your server: the browser never chooses a lock. To
	 * lock per upload, call `devultur.createUploadUrl(ctx, { lock })` from your own function.
	 */
	lock?: ObjectLock;
	/**
	 * Visibility of an upload whose caller passes none. Without it, the Worker's default by type applies. A default,
	 * not a rule: the browser's `visibility` wins over it, and a guard's `args` win over both (see `DevulturGuardResult`).
	 */
	visibility?: Visibility;
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
