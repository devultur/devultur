export function videoBasePath(id: string): string {
	return `video/${id}`;
}

export function videoRawPath(id: string, filename: string): string {
	return `video/${id}/raw/${filename}`;
}

// True when the key points to a video's raw/original (`video/{id}/raw/...`), with or without
// a storagePrefix in front. Single source of truth for the `raw/` convention (used by the IA
// storage class and any logic that must treat the raw differently from HLS renditions).
export function isVideoRawKey(key: string): boolean {
	return /(?:^|\/)video\/[^/]+\/raw\//.test(key);
}

export function videoHlsPath(id: string): string {
	return `video/${id}/hls`;
}

export function videoHlsPlaylistPath(id: string): string {
	return `video/${id}/hls/playlist.m3u8`;
}

export function videoThumbnailPath(id: string): string {
	return `video/${id}/thumbnails/thumbnail.jpg`;
}

// Poster at the video's resolution (the thumbnail is its 640px version). AVIF/WebP are derived from it via transforms.
export function videoPosterPath(id: string): string {
	return `video/${id}/thumbnails/poster.jpg`;
}

// Folder for a video's standalone MP4s (progressive renditions, outside the HLS ladder).
export function videoMp4Dir(id: string): string {
	return `video/${id}/mp4`;
}

// MP4 for a given framing and rung: `video/{id}/mp4/{variant}-{rung}.mp4` (e.g. `main-1080p.mp4`, `vertical-1080p.mp4`).
export function videoMp4Path(id: string, variant: string, rung: string): string {
	return `${videoMp4Dir(id)}/${variant}-${rung}.mp4`;
}

// Storyboard (scrub-bar previews): `storyboard.vtt` + `sprite-N.jpg` in the same folder (the VTT
// references the sprites with relative paths).
export function videoStoryboardDir(id: string): string {
	return `video/${id}/storyboard`;
}

export function videoStoryboardPath(id: string): string {
	return `${videoStoryboardDir(id)}/storyboard.vtt`;
}

export function imagePath(id: string, filename: string): string {
	return `image/${id}/${filename}`;
}

export function filePath(id: string, filename: string): string {
	return `file/${id}/${filename}`;
}

export function captionPath(videoId: string, locale: string): string {
	return `video/${videoId}/captions/${locale}.vtt`;
}

const VISIBILITY_PREFIXES = new Set(["public", "private"]);

export function extractId(key: string): string {
	const parts = key.split("/");
	// Delivery/upload keys carry a visibility prefix: `{visibility}/{kind}/{id}/…` → id at [2].
	// The internal path helpers (`videoHlsPath`, etc.) don't: `{kind}/{id}/…` → id at [1]. Without this
	// offset, a `private/video/{uuid}/…` returned "video" (the kind) → mis-keyed record → the UI never
	// receives the transcode state.
	const offset = VISIBILITY_PREFIXES.has(parts[0] ?? "") ? 1 : 0;
	return parts[offset + 1] ?? parts[offset] ?? key;
}

export function generateId(): string {
	return crypto.randomUUID();
}

export function extractKeyFromUrl(url: string, baseUrl: string): string | null {
	if (!url.startsWith(baseUrl)) return null;
	const path = url.slice(baseUrl.length);
	const withoutPrefix = path.replace(/^\/v1\/media\//, "");
	const withoutQuery = withoutPrefix.split("?")[0];
	return withoutQuery || null;
}
