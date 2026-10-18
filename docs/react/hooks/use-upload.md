# useUpload

Headless presigned upload with progress — the hook behind UploadZone.

`useUpload` performs a presigned `PUT` and tracks progress. Reach for it when you
want upload behavior without the [`UploadZone`](../components/upload-zone.md) UI.

## Import

```tsx
import { useUpload } from "@devultur/react";
```

## Usage

```tsx
const { upload, progress, isUploading, error } = useUpload({
  onUploadUrl: async (file) => getUploadUrl({ filename: file.name, contentType: file.type }),
  onComplete: (result) => console.log("Uploaded:", result.key),
});

<input type="file" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />;
```

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `onUploadUrl` | `(file: File) => Promise<{ url: string; key: string }>` | Required | Resolves the presigned URL and key for a file. |
| `onComplete` | `(result: { key: string; file: File }) => void` | — | Called on a successful upload. |
| `onProgress` | `(percent: number) => void` | — | Called with progress, 0–100. |
| `onError` | `(error: Error) => void` | — | Called when the upload fails. |

## Returns

| Field | Type | Description |
| --- | --- | --- |
| `upload` | `(file: File) => void` | Start uploading a file. |
| `progress` | `number` | Upload progress, 0–100. |
| `isUploading` | `boolean` | An upload is in progress. |
| `error` | `Error \| null` | The last upload error. |
| `reset` | `() => void` | Clear progress and error state. |

## See also

- [UploadZone](../components/upload-zone.md) — the styled component built on this hook.
