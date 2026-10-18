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
  startTime={progress.lastPosition}
  onProgress={(time) => saveProgress(video.id, time)}
  onEnded={() => markComplete(video.id)}
/>
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
