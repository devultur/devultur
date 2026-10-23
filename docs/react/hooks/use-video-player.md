# useVideoPlayer

Headless HLS playback — state, controls, and a video ref for a fully custom player.

`useVideoPlayer` wires up HLS.js, exposes playback state and controls, and hands
you a `ref` to attach to your own `<video>`. It's the engine behind
[`VideoPlayer`](../components/video-player.md) — use it to build a bespoke UI.

## Import

```tsx
import { useVideoPlayer } from "@devultur/react";
```

## Usage

```tsx
const { ref, state, controls } = useVideoPlayer({
  src: playlistUrl,
  token: viewerToken,
  onProgress: (time) => saveProgress(time),
});

return (
  <div>
    <video ref={ref} />
    <button onClick={controls.togglePlay}>{state.isPlaying ? "Pause" : "Play"}</button>
  </div>
);
```

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `src` | `string` | Required | HLS playlist (`.m3u8`) URL. |
| `token` | `string` | — | Delivery JWT for segment/caption requests. |
| `initialTime` | `number` | — | Seconds to seek to on load. |
| `progressInterval` | `number` | — | Minimum ms between `onProgress` calls. |
| `containerRef` | `RefObject<HTMLElement \| null>` | — | Container used for fullscreen. |
| `onProgress` | `(currentTime: number, percent: number) => void` | — | Fired as playback advances. |
| `onEnded` | `() => void` | — | Fired when playback ends. |
| `onError` | `(error: VideoPlayerError) => void` | — | Fired when the playlist or a segment can't load (a `401`, or an error hls.js can't recover from). |
| `metrics` | `boolean` | `true` | Anonymous playback quality beacons, with no cookies, to the video's own host. `false` turns them off. See [Playback metrics](../../guides/video-player.md#playback-metrics). |

## Returns

| Field | Type | Description |
| --- | --- | --- |
| `ref` | `RefObject<HTMLVideoElement \| null>` | Attach to your `<video>` element. |
| `state` | `VideoPlayerRenderProps["state"]` | Playback state (time, volume, quality levels, …). |
| `controls` | `VideoPlayerRenderProps["controls"]` | Imperative controls (`play`, `seek`, `setQuality`, …). |
| `hlsInstance` | `Hls \| null` | The underlying HLS.js instance, when active. |

## See also

- [VideoPlayer](../components/video-player.md) — the batteries-included component.
