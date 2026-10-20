import type { ObjectLock, VideoModuleConfig } from "@devultur/core";

export interface DevulturComponentConfig {
	video?: VideoModuleConfig;
	/**
	 * Lock every upload through the exposed `createUploadUrl` gets (retention and/or hold). Set here, on your server:
	 * the browser never chooses a lock. To lock per upload, call `devultur.createUploadUrl(ctx, { lock })` from your
	 * own function.
	 */
	upload?: { lock?: ObjectLock };
}

export interface MediaRecord {
	/** The media id (the `id` of its `DevulturMedia`), for every kind. */
	key: string;
	type: "video" | "image" | "file";
	filename: string;
	contentType: string;
	sizeBytes: number;
	/** Set by a confirmed upload; unset on records from before 1.1.0. */
	visibility?: "public" | "private";
	/** Key of the uploaded object (a video's raw file). Set by a confirmed upload. */
	objectKey?: string;
	width?: number;
	height?: number;
	transcodeStatus?: "queued" | "transcoding" | "captioning" | "ready" | "failed";
	transcodeProgress?: { current: number; total: number };
	transcodeError?: string;
	playlistUrl?: string;
	thumbnailKey?: string;
	/** Key of the storyboard VTT (hover previews); URL via `buildStoryboardUrl` from `@devultur/core`. */
	storyboardKey?: string;
	captionLocales?: string[];
	/** True while requested captions haven't arrived; the video waits in "captioning" only then. */
	captionsPending?: boolean;
	duration?: number;
	createdAt: number;
}

export interface ProgressRecord {
	userId: string;
	videoId: string;
	lastPosition: number;
	completedAt?: number;
	watchedPercent?: number;
	updatedAt: number;
}
