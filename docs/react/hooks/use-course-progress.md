# useCourseProgress

Aggregate completion across a set of lessons.

`useCourseProgress` rolls up per-video completion into a course-level summary,
using the same [`ProgressProvider`](../components/progress-provider.md) callbacks.

## Import

```tsx
import { useCourseProgress } from "@devultur/react";
```

## Usage

```tsx
function CourseCard({ courseId, lessonIds }) {
  const { percent, completedCount, totalCount, isComplete } = useCourseProgress(courseId, lessonIds);

  return (
    <p>
      {completedCount}/{totalCount} lessons ({percent}%){isComplete && " — Complete"}
    </p>
  );
}
```

## Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `courseId` | `string` | Identifier for the course. |
| `lessonIds` | `string[]` | The video IDs that make up the course. |

## Returns

| Field | Type | Description |
| --- | --- | --- |
| `percent` | `number` | Completion percentage, 0–100. |
| `completedCount` | `number` | Number of completed lessons. |
| `totalCount` | `number` | Total number of lessons. |
| `isComplete` | `boolean` | All lessons are complete. |

## See also

- [useProgress](use-progress.md) · [ProgressProvider](../components/progress-provider.md)
