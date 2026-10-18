# Video processing

Transcode uploaded videos to adaptive HLS and generate captions with the useVideoProcessing hook.

After a video is uploaded, trigger transcoding and captions. The `useVideoProcessing`
hook drives the full lifecycle for you.

```tsx
import { useVideoProcessing } from "@devultur/react";
import { media } from "@/lib/media";

function VideoUploadForm({ uploadedKey }) {
  const {
    status,        // "idle" | "starting" | "transcoding" | "captioning" | "ready" | "error"
    transcodeReady,
    captionsReady,
    playlistUrl,
    thumbnailUrl,
    vttUrls,       // { "es-CO": "https://..." }
    error,
  } = useVideoProcessing(media, uploadedKey, {
    locales: ["es-CO", "en"],
    // preset: "hero",   // optional — omit it to use the Worker's default preset
    pollInterval: 5000,     // default: 5s
  });

  if (status === "error") return <p>Error: {error}</p>;
  if (status !== "ready") return <p>Processing: {status}...</p>;

  return <p>Ready! Playlist: {playlistUrl}</p>;
}
```

The hook triggers `media.transcode()` and `media.requestCaptions()` automatically,
tracks progress, and cleans up on unmount.

For manual control, pass `autoStart: false` and call `start()` yourself.

## Choosing the outputs

Without a `preset`, the Worker uses its default preset (`config.transcode.presets` in
`createWorker`), or the adaptive HLS ladder if none is set. The ladder never upscales: only
renditions at or below the source height are encoded, up to `config.transcode.maxResolution`.
See the [self-host guide](self-host.md#rules-per-request-scope-and-hooks).

## Receiving the webhook

When you start a transcode with a `callbackUrl`, the Worker posts every event of the job to it as JSON
(`transcode.started`, `transcode.progress`, `transcode.complete`, `transcode.failed`, and `captions.complete` /
`captions.failed` for captions), with `Authorization: Bearer <WORKER_AUTH_SECRET>`. `createWebhookHandler` checks the
bearer and hands you the typed event:

```typescript
import { createWebhookHandler } from "@devultur/server";
import { media } from "./media";

export const handleMediaWebhook = createWebhookHandler(media, {
  secret: process.env.WORKER_AUTH_SECRET!,
  onTranscodeComplete: async (event) => {
    await db.videos.update(event.videoId, { playlist: event.playlistKey, duration: event.duration });
  },
  onTranscodeFailed: async (event) => {
    await db.videos.update(event.videoId, { error: event.error, retriable: event.retriable });
  },
});
```

A wrong or missing bearer gets `401` and no callback runs. Use `onEvent` to receive every event, including progress.
With Convex, `@devultur/convex` registers this route for you.
