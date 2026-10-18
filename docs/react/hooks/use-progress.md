# useProgress

Track and resume playback position for a single video.

`useProgress` reads and writes a video's playback position through the callbacks
you gave [`ProgressProvider`](../components/progress-provider.md). Writes are
throttled so you can call `update` on every tick.

## Import

```tsx
import { useProgress } from "@devultur/react";
```

## Usage

```tsx
function Lesson({ videoId }) {
  const { progress, update, markComplete } = useProgress(videoId);

  return (
    <VideoPlayer
      src={playlistUrl}
      initialTime={progress.lastPosition}
      onProgress={(time) => update(time)}
      onEnded={() => markComplete()}
    />
  );
}
```

## Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `videoId` | `string` | The video to track. |
| `options` | `UseProgressOptions` | See below. |

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `flushInterval` | `"1s" \| "5s" \| "10s" \| "30s"` | `"5s"` | How often throttled `update` calls are flushed to `onSave`. |

## Returns

| Field | Type | Description |
| --- | --- | --- |
| `progress` | `{ lastPosition: number; completedAt: Date \| null; percent: number }` | The loaded progress state. |
| `isLoading` | `boolean` | Initial load is in flight. |
| `update` | `(position: number) => void` | Record the latest position (throttled). |
| `markComplete` | `() => Promise<void>` | Mark the video complete. |
| `reset` | `() => Promise<void>` | Clear saved progress. |

## See also

- [ProgressProvider](../components/progress-provider.md) · [useCourseProgress](use-course-progress.md)
- [Progress tracking guide](../../guides/progress-tracking.md)
