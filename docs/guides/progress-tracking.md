# Progress tracking

Resume playback where users left off and aggregate course completion with the progress hooks.

The progress hooks are backend-agnostic: you provide save/load callbacks and
Devultur wires them into the player.

## Per-video progress

Wrap your app with `ProgressProvider`, then use `useProgress` in lesson components:

```tsx
import { ProgressProvider, useProgress } from "@devultur/react";

// Wrap your app (backend-agnostic — you own persistence)
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
</ProgressProvider>;

// In a lesson component
function Lesson({ videoId }) {
  const { progress, update, markComplete } = useProgress(videoId);

  return (
    <VideoPlayer
      src={playlistUrl}
      startTime={progress.lastPosition}
      onProgress={(time) => update(time)}
      onEnded={() => markComplete()}
    />
  );
}
```

## Course progress

Aggregate completion across a set of lessons:

```tsx
import { useCourseProgress } from "@devultur/react";

function CourseCard({ courseId, lessonIds }) {
  const { percent, completedCount, totalCount, isComplete } = useCourseProgress(courseId, lessonIds);

  return (
    <div>
      <p>{completedCount}/{totalCount} lessons ({percent}%)</p>
      {isComplete && <span>Complete</span>}
    </div>
  );
}
```
