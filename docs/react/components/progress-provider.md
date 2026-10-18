# ProgressProvider

Backend-agnostic provider that wires playback progress persistence into the progress hooks.

`ProgressProvider` supplies the save/load callbacks used by [`useProgress`](../hooks/use-progress.md)
and [`useCourseProgress`](../hooks/use-course-progress.md). You own persistence —
Devultur just calls your callbacks. Wrap your app (or the subtree that plays media)
with it once.

## Import

```tsx
import { ProgressProvider } from "@devultur/react";
```

## Usage

```tsx
<ProgressProvider
  onSave={async (videoId, position) => {
    await saveProgressMutation({ videoId, position });
  }}
  onLoad={async (videoId) => {
    return await getProgress({ videoId });
  }}
  onMarkComplete={async (videoId) => {
    await markCompleteMutation({ videoId });
  }}
  onReset={async (videoId) => {
    await resetProgressMutation({ videoId });
  }}
>
  <App />
</ProgressProvider>
```

## Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `onSave` | `(videoId: string, position: number) => Promise<void>` | Required | Persists the latest playback position. |
| `onLoad` | `(videoId: string) => Promise<{ lastPosition: number; completedAt: Date \| null } \| null>` | Required | Loads the saved position for a video. |
| `onMarkComplete` | `(videoId: string) => Promise<void>` | Required | Marks a video complete. |
| `onReset` | `(videoId: string) => Promise<void>` | Required | Clears saved progress for a video. |
| `children` | `ReactNode` | Required | The subtree that uses the progress hooks. |

## See also

- [useProgress](../hooks/use-progress.md) · [useCourseProgress](../hooks/use-course-progress.md)
- [Progress tracking guide](../../guides/progress-tracking.md)
