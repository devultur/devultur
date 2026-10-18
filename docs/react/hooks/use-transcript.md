# useTranscript

Parse a caption track into cues and track the active line for a custom transcript UI.

`useTranscript` fetches and parses a caption VTT into cues and tells you which cue
is active at the current time. It's the hook behind
[`TranscriptPanel`](../components/transcript-panel.md) — use it to build your own.

## Import

```tsx
import { useTranscript } from "@devultur/react";
```

## Usage

```tsx
const { cues, activeCueIndex, isLoading } = useTranscript({
  captions: tracks,
  locale: "es-CO",
  currentTime,
  token: viewerToken,
});

return (
  <ul>
    {cues.map((cue, i) => (
      <li key={i} data-active={i === activeCueIndex}>
        {cue.text}
      </li>
    ))}
  </ul>
);
```

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `captions` | `CaptionTrack[]` | — | Available caption tracks. |
| `locale` | `string` | Required | Locale of the transcript to parse. |
| `currentTime` | `number` | Required | Current playback time; drives `activeCueIndex`. |
| `token` | `string` | — | Delivery JWT for fetching the VTT. |

## Returns

| Field | Type | Description |
| --- | --- | --- |
| `cues` | `VttCue[]` | Parsed cues, each with `start`, `end`, and `text`. |
| `activeCueIndex` | `number` | Index of the cue active at `currentTime`, or `-1`. |
| `isLoading` | `boolean` | The VTT is being fetched/parsed. |

## See also

- [TranscriptPanel](../components/transcript-panel.md) — the ready-made transcript component.
