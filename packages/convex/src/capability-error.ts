/** What `useDevultur()` can do only under a `<DevulturProvider>` given the matching actions. */
export type DevulturCapability = "upload" | "uploadUrl" | "deleteMedia" | "api";

/**
 * Thrown (or rejected) when an app calls something its provider wasn't given: `upload`, `uploadUrl` or `deleteMedia`
 * under a `<DevulturViewerProvider>`, or a hook that needs the `api` (`useMediaUpload`, `<MediaLibrary>`, ...).
 * Stable `code`: `capability_unavailable`.
 */
export class DevulturCapabilityError extends Error {
	readonly code = "capability_unavailable";
	readonly capability: DevulturCapability;

	constructor(capability: DevulturCapability) {
		super(
			`Devultur: \`${capability}\` isn't available under <DevulturViewerProvider>. Use <DevulturProvider api> with the actions it needs.`,
		);
		this.name = "DevulturCapabilityError";
		this.capability = capability;
	}
}
