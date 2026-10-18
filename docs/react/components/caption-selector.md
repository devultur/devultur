# CaptionSelector

A dropdown to switch between caption tracks, with an optional "Off" entry.

`CaptionSelector` renders a `<select>` for switching caption locales. Use it when
you build a custom player UI and want a ready-made caption menu.

## Import

```tsx
import { CaptionSelector } from "@devultur/react";
```

## Usage

```tsx
<CaptionSelector
  captions={[
    { locale: "es-CO", label: "Español" },
    { locale: "en", label: "English" },
  ]}
  activeLocale={activeLocale}
  onSelect={setActiveLocale}
/>
```

## Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `captions` | `{ locale: string; label: string }[]` | Required | The caption tracks to list. |
| `activeLocale` | `string \| null` | Required | Currently selected locale, or `null` when captions are off. |
| `onSelect` | `(locale: string \| null) => void` | Required | Called with the chosen locale, or `null` for "Off". |
| `includeOff` | `boolean` | `true` | Whether to include an "Off" option. |
| `className` | `string` | — | Class applied to the `<select>`. |

## See also

- [CaptionOverlay](caption-overlay.md) — renders the active captions over the video.
- [VideoPlayer](video-player.md) — includes a caption menu out of the box.
