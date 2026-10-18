import type { VideoModuleConfig } from "@devultur/core";

export interface DevulturComponentConfig {
	video?: VideoModuleConfig;
}

export interface MediaRecord {
	key: string;
	type: "video" | "image" | "file";
	filename: string;
	contentType: string;
	sizeBytes: number;
	transcodeStatus?: "transcoding" | "captioning" | "ready" | "failed";
	transcodeProgress?: { current: number; total: number };
	transcodeError?: string;
	playlistUrl?: string;
	thumbnailKey?: string;
	/** Key of the storyboard VTT (hover previews); URL via `buildStoryboardUrl` from `@devultur/core`. */
	storyboardKey?: string;
	captionLocales?: string[];
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
