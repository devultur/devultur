# VideoPlayer

Adaptive HLS player with captions, a quality picker, and keyboard shortcuts.

> [!IMPORTANT]
> Playback metrics are on by default: anonymous, with no cookies, sent to the media host that serves the video.
> `metrics={false}` turns them off. [What is sent and where](../../guides/video-player.md#playback-metrics).

`VideoPlayer` streams HLS with adaptive bitrate, a built-in quality picker,
caption tracks, and keyboard shortcuts. Use it styled out of the box, or pass a
render function for a fully custom UI.

## Import

```tsx
import { VideoPlayer } from "@devultur/react";
```

## Usage

```tsx
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

## Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `src` | `string` | Required | HLS playlist (`.m3u8`) URL. |
| `token` | `string` | — | Delivery JWT appended to segment/caption requests. |
| `captions` | `CaptionTrack[]` | — | Subtitle tracks to offer in the caption menu. |
| `defaultCaption` | `string` | — | Locale of the caption enabled on first load. |
| `initialTime` | `number` | `0` | Seconds to seek to on mount (resume playback). |
| `playbackRates` | `number[]` | `[0.5, 0.75, 1, 1.25, 1.5, 2]` | Speeds offered in the speed menu. |
| `progressInterval` | `number` | — | Minimum ms between `onProgress` calls (throttle). Omit to fire on every tick. |
| `onProgress` | `(currentTime: number, percent: number) => void` | — | Fired as playback advances. |
| `onEnded` | `() => void` | — | Fired when playback reaches the end. |
| `onError` | `(error: VideoPlayerError) => void` | — | Fired when the playlist or a segment can't load: on a `401` (even when hls.js would keep trying) and on any error hls.js can't recover from. `VideoPlayerError` has the HTTP `status`, the response body's `code` (e.g. `session_mismatch`), `fatal` and hls.js's `details`. |
| `metrics` | `boolean` | `true` | Anonymous playback quality beacons (startup, rebuffering, errors, bitrate, watch time), with no cookies, to `POST /v1/metrics/playback` on the video's own host, for Devultur delivery URLs only. The self-host Worker accepts and discards them. `false` turns them off. See [Playback metrics](../../guides/video-player.md#playback-metrics). |
| `labels` | `Partial<VideoPlayerLabels>` | English | The strings the player and its controls show or announce (accessible names, menu items). Pass any subset; `defaultVideoPlayerLabels` has the rest. Spanish: `videoPlayerLabels` from `@devultur/convex/locales/es` or `locales/es-formal`. |
| `aspectRatio` | `string` | — | CSS `aspect-ratio` for the player container (e.g. `"16 / 9"`). |
| `className` | `string` | — | Class applied to the player container. |
| `children` | `ReactNode \| (state: VideoPlayerRenderProps) => ReactNode` | — | Custom UI, or a render function for headless control. |

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` `→` | Seek ∓10s |
| `↑` `↓` | Volume ∓10% |
| `F` | Fullscreen |
| `C` | Toggle captions |
| `M` | Mute |

## Labels

```tsx
import { VideoPlayer } from "@devultur/react";
import { videoPlayerLabels } from "@devultur/convex/locales/es";

<VideoPlayer src={video.playlistUrl} labels={videoPlayerLabels} />;
```

The controls exported on their own (`PlayButton`, `SeekBar`, `VolumeControl`, `CaptionButton`, `QualityButton`,
`SpeedButton`, `FullscreenButton`, `DefaultControls`) take the same `labels` prop.

## Imperative ref

Attach a `ref` to control the player programmatically via `VideoPlayerRef`:

```tsx
const playerRef = useRef<VideoPlayerRef>(null);
// playerRef.current?.seek(30);
```

`VideoPlayerRef` exposes `seek`, `play`, `pause`, `togglePlay`, `setVolume`,
`toggleMute`, `toggleFullscreen`, `setCaption`, `setPlaybackRate`, `setQuality`,
and a readonly `state`.

## See also

- [useVideoPlayer](../hooks/use-video-player.md) — the headless hook behind this component.
- [Video player guide](../../guides/video-player.md)
