# Devultur docs

Guides for the self-hosted media Worker and the SDKs. The API reference is generated from the TSDoc in each
package's source.

## Guides

- [Self-host the media Worker](guides/self-host.md): deploy, secrets, routes, rules, transcode runners, image
  transforms
- [Plugins](guides/plugins.md): extend the Worker (auth, request state, hooks) and the example plugins
- [Uploads](guides/uploads.md)
- [Media references & delivery](guides/media-references.md)
- [Video processing](guides/video-processing.md)
- [Video player](guides/video-player.md)
- [Progress tracking](guides/progress-tracking.md)
- [Security](guides/security.md)
- [Framework examples](guides/framework-examples.md)
- [Convex component with a self-hosted Worker](../packages/convex/README.md#using-a-self-hosted-worker)

## React

- Components: [VideoPlayer](react/components/video-player.md), [UploadZone](react/components/upload-zone.md),
  [CaptionOverlay](react/components/caption-overlay.md), [CaptionSelector](react/components/caption-selector.md),
  [TranscriptPanel](react/components/transcript-panel.md), [ProgressProvider](react/components/progress-provider.md)
- Hooks: [useVideoPlayer](react/hooks/use-video-player.md), [useUpload](react/hooks/use-upload.md),
  [useVideoProcessing](react/hooks/use-video-processing.md), [useTranscript](react/hooks/use-transcript.md),
  [useProgress](react/hooks/use-progress.md), [useCourseProgress](react/hooks/use-course-progress.md)
