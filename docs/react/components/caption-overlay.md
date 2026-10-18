# CaptionOverlay

Renders the active caption cue over a video at the current playback time.

`CaptionOverlay` fetches and parses the active caption track and renders the cue
for the current time. Use it when building a custom player and you want captions
rendered on top of your own video element.

## Import

```tsx
import { CaptionOverlay } from "@devultur/react";
```

## Usage

```tsx
<CaptionOverlay
  captions={tracks}
  activeLocale={activeLocale}
  currentTime={currentTime}
  token={viewerToken}
/>
```

## Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `captions` | `CaptionTrack[]` | — | Available caption tracks. |
| `activeLocale` | `string \| null` | Required | Locale to render, or `null` to hide captions. |
| `currentTime` | `number` | Required | Current playback time in seconds; selects the cue to show. |
| `controlsVisible` | `boolean` | — | Nudges captions up when player controls are visible. |
| `token` | `string` | — | Delivery JWT for fetching the caption VTT. |

## See also

- [CaptionSelector](caption-selector.md) — the caption menu.
- [useTranscript](../hooks/use-transcript.md) — parse cues yourself for a transcript UI.
