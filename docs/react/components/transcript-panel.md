# TranscriptPanel

A clickable, auto-scrolling transcript built from a caption track.

`TranscriptPanel` renders the caption cues as a readable transcript, highlights
the active line, and lets the viewer click a line to seek.

## Import

```tsx
import { TranscriptPanel } from "@devultur/react";
```

## Usage

```tsx
<TranscriptPanel
  captions={tracks}
  locale="es-CO"
  currentTime={currentTime}
  token={viewerToken}
  onSeek={(seconds) => playerRef.current?.seek(seconds)}
/>
```

## Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `captions` | `CaptionTrack[]` | — | Available caption tracks. |
| `locale` | `string` | Required | Locale of the transcript to render. |
| `currentTime` | `number` | Required | Current playback time; highlights the active cue. |
| `token` | `string` | — | Delivery JWT for fetching the caption VTT. |
| `onSeek` | `(seconds: number) => void` | — | Called with a cue's start time when a line is clicked. |
| `className` | `string` | — | Class applied to the panel container. |

## See also

- [useTranscript](../hooks/use-transcript.md) — the hook powering this panel, for a custom transcript UI.
