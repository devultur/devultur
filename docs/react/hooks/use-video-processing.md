# useVideoProcessing

Drive the full transcode + captions lifecycle for an uploaded video from one hook.

`useVideoProcessing` triggers transcoding and captions for an uploaded key, polls
for status, and exposes the resulting playlist, thumbnail, and caption URLs. It
cleans up on unmount.

## Import

```tsx
import { useVideoProcessing } from "@devultur/react";
```

## Usage

```tsx
function VideoUploadForm({ uploadedKey }) {
  const { status, playlistUrl, vttUrls, error } = useVideoProcessing(media, uploadedKey, {
    locales: ["es-CO", "en"],
  });

  if (status === "error") return <p>Error: {error}</p>;
  if (status !== "ready") return <p>Processing: {status}…</p>;
  return <p>Ready! Playlist: {playlistUrl}</p>;
}
```

## Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `media` | `MediaRouterLike` | Your configured media router. |
| `key` | `string` | The uploaded object key to process. |
| `options` | `UseVideoProcessingOptions` | See below. |

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `locales` | `string[]` | `[]` | Caption locales to request (transcription + translations). |
| `preset` | `string` | `"hls-720p"` | Transcode preset. The Worker caps resolution at `config.transcode.maxResolution`. |
| `pollInterval` | `number` | `5000` | Status poll interval in ms. |
| `autoStart` | `boolean` | `true` | Start automatically on mount. Set `false` and call `start()` yourself for manual control. |

## Returns

| Field | Type | Description |
| --- | --- | --- |
| `status` | `"idle" \| "starting" \| "transcoding" \| "captioning" \| "ready" \| "error"` | Current lifecycle stage. |
| `transcodeReady` | `boolean` | Transcoding has finished. |
| `captionsReady` | `boolean` | Captions have finished. |
| `playlistUrl` | `string \| null` | HLS playlist URL once ready. |
| `thumbnailUrl` | `string \| null` | Generated thumbnail URL. |
| `vttUrls` | `Record<string, string>` | VTT URL per locale, e.g. `{ "es-CO": "…" }`. |
| `error` | `string \| null` | Error message when `status` is `"error"`. |
| `start` | `() => void` | Manually start processing (with `autoStart: false`). |

## See also

- [Video processing guide](../../guides/video-processing.md)
