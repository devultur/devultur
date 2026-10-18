# VideoPlayer

Adaptive HLS player with captions, a quality picker, and keyboard shortcuts.

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
| `metrics` | `boolean` | `true` | Playback analytics beacons (startup, rebuffering, errors, bitrate, watch time) to `POST /v1/metrics/playback` on the media host. The self-host Worker accepts and discards them. `false` opts out. |
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
