/**
 * Every string `<VideoPlayer>` and its default controls show or announce. Pass any subset as `labels` on
 * `<VideoPlayer>` (or on a control used on its own); the rest keep the English defaults.
 */
export interface VideoPlayerLabels {
	/** Accessible name of the player. */
	player: string;
	/** Accessible name of the control bar. */
	controls: string;
	play: string;
	pause: string;
	/** Accessible name of the seek bar. */
	seek: string;
	mute: string;
	unmute: string;
	/** Accessible name of the volume slider. */
	volume: string;
	/** Accessible name of the captions button. */
	captions: string;
	/** Menu item that turns captions off. */
	captionsOff: string;
	/** Accessible name of the quality button. */
	quality: string;
	/** Automatic quality: the button's text while it's active, and its menu item. */
	qualityAuto: string;
	/** Accessible name of the speed button. */
	speed: string;
	/** Menu item for the normal speed (1x). */
	speedNormal: string;
	fullscreen: string;
	exitFullscreen: string;
}

export const defaultVideoPlayerLabels: VideoPlayerLabels = {
	player: "Video player",
	controls: "Video controls",
	play: "Play",
	pause: "Pause",
	seek: "Seek",
	mute: "Mute",
	unmute: "Unmute",
	volume: "Volume",
	captions: "Captions",
	captionsOff: "Off",
	quality: "Video quality",
	qualityAuto: "Auto",
	speed: "Playback speed",
	speedNormal: "Normal",
	fullscreen: "Fullscreen",
	exitFullscreen: "Exit fullscreen",
};

/** The defaults with `labels` over them; a key set to `undefined` keeps the default instead of erasing it. */
export function resolveVideoPlayerLabels(labels?: Partial<VideoPlayerLabels>): VideoPlayerLabels {
	if (!labels) return defaultVideoPlayerLabels;
	const resolved: VideoPlayerLabels = { ...defaultVideoPlayerLabels };
	for (const name of Object.keys(labels) as Array<keyof VideoPlayerLabels>) {
		const label = labels[name];
		if (label !== undefined) resolved[name] = label;
	}
	return resolved;
}
