# Video player

Stream adaptive HLS with captions, quality selection, and keyboard shortcuts using the VideoPlayer component.

`VideoPlayer` streams HLS with adaptive bitrate, a quality picker, captions, and
keyboard shortcuts out of the box.

```tsx
import { VideoPlayer } from "@devultur/react";

<VideoPlayer
  src={video.playlistUrl}
  token={viewerToken}
  captions={[
    { locale: "es-CO", label: "Español", src: video.captions.esCO },
    { locale: "en", label: "English", src: video.captions.en },
  ]}
  defaultCaption="es-CO"
  initialTime={progress.lastPosition}
  onProgress={(time) => saveProgress(video.id, time)}
  onEnded={() => markComplete(video.id)}
/>
```

## Playback metrics

> [!IMPORTANT]
> Playback metrics are **on by default**. They're anonymous and set no cookies. To turn them off, pass
> `metrics={false}`:
>
> ```tsx
> <VideoPlayer src={video.playlistUrl} metrics={false} />
> ```
>
> `useVideoPlayer({ metrics: false })` does the same for a custom player. With `metrics={false}` the player adds no
> listeners and sends nothing.

The player measures the quality of each view (how long the first frame took, rebuffering, errors, bitrate, watch time)
and sends it to the media host that serves the video.

### When anything is sent

Only when `src` is a Devultur delivery URL: an `http:` or `https:` URL whose path contains `/v1/media/`. Any other
source sends nothing, whatever `metrics` says.

### Where it goes

`POST /v1/metrics/playback` on the video's own origin, after the same path prefix: a video at
`https://media.example.com/v1/media/public/video/abc/hls/playlist.m3u8` reports to
`https://media.example.com/v1/metrics/playback`. Nothing goes to any other host. The self-host Worker answers `204` and
discards the body; a [plugin](plugins.md) can record it instead.

The player sends with `navigator.sendBeacon` (falling back to `fetch` with `keepalive`, `credentials: "omit"` and
`mode: "no-cors"`), as `text/plain` JSON. It sends every 30 seconds while something changed, when the tab is hidden,
when the page is closed, when the video ends, and when the player unmounts or `src` changes. A beacon that is lost is
never retried and never shows as an error.

### What is sent

One JSON object per beacon, with the changes since the previous one:

| Field | What it is |
| --- | --- |
| `v` | Beacon format version (`1`). |
| `viewId` | A random id for this view (`crypto.randomUUID()`). It isn't derived from the device or the user, and isn't stored: two views of the same video never share it. |
| `key` | The media key after `/v1/media/` (for example `public/video/abc/hls/playlist.m3u8`), without the query string. |
| `seq` | The beacon's number within the view. |
| `engine` | `hls.js`, `native` (the browser's own HLS) or `progressive` (a plain file). |
| `viewStart` | `1` on the view's first beacon. |
| `startupMs` | Time to the first frame, on the beacon where it happened. |
| `watchMs` | Time spent playing. |
| `rebufferCount`, `rebufferMs` | How often and how long playback stalled. |
| `fatalErrors`, `nonFatalErrors`, `errorCode` | Playback errors, and the last error code (an hls.js or `MEDIA_ERR_*` code). |
| `erroredView` | `1` on the beacon with the view's first fatal error. |
| `renditionSwitches` | How often the quality changed. |
| `bitrateKbpsMs`, `bitrateWatchMs` | Bitrate × time played, and the time played at a known bitrate (for the average bitrate). |
| `completionDelta` | How far the furthest position reached moved, in percentage points. |
| `durationS` | The video's duration in seconds. |
| `token` | Only for a private video, and only when the player's `token` is a viewer JWT: it lets the media host find which storage the beacon belongs to. Any other kind of token is never put in a beacon. |

No cookies, no local storage, no user id, no page URL and no device fingerprint. Like any request, the beacon reaches
the media host with the viewer's IP address, user agent and the page's origin (and its referrer, as the page's
referrer policy allows); the body carries none of them.

## Labels

Every string the player shows or announces can be replaced with `labels` (`VideoPlayerLabels`). Pass any subset; the
rest keep the English defaults (`defaultVideoPlayerLabels`). `@devultur/convex/locales/es` and `locales/es-formal`
export Spanish ones as `videoPlayerLabels`.

```tsx
<VideoPlayer src={video.playlistUrl} labels={{ play: "Reproducir", pause: "Pausar" }} />
```

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` `→` | Seek |
| `↑` `↓` | Volume |
| `F` | Fullscreen |
| `C` | Toggle captions |
| `M` | Mute |
