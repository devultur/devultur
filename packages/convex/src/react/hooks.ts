"use client";

export { useMediaUrl, useVideoProps, type VideoProps } from "../media-url-hooks";
// `@devultur/convex/react/hooks`: the contexts and the hooks that read them, without the components (`<MediaPicker>`,
// `<MediaLibrary>`, `<Preview>`…) or their dependencies (hls.js, pdf.js). The contexts are the very objects
// `@devultur/convex/react` exports, so `<DevulturProvider>` from there fills the hooks imported from here.
export {
	type DevulturApi,
	DevulturApiContext,
	DevulturContext,
	type DevulturContextValue,
	DevulturProgressContext,
	type DevulturProgressContextValue,
	type UploadedMedia,
	type UploadOptions,
	useCanDeliver,
	useDevultur,
	useDevulturApi,
	useDevulturOptional,
	useDevulturProgress,
} from "./contexts";
