# UploadZone

Drag-and-drop and click-to-select file upload zone with validation and progress — styled or headless.

`UploadZone` handles drag-and-drop, client-side validation, and the presigned
`PUT` for you. Give it a way to fetch an upload URL and it manages the rest.

## Import

```tsx
import { UploadZone } from "@devultur/react";
```

## Usage

```tsx
function VideoUpload() {
  return (
    <UploadZone
      onUploadUrl={async (file) => {
        const res = await getUploadUrl({ filename: file.name, contentType: file.type });
        return { url: res.url, key: res.key };
      }}
      onComplete={(result) => console.log("Uploaded:", result.key)}
      accept={["video/mp4", "video/quicktime"]}
    />
  );
}
```

## Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `onUploadUrl` | `(file: File) => Promise<{ url: string; key: string }>` | Required | Resolves the presigned upload URL and object key for the selected file. |
| `onComplete` | `(result: { key: string; file: File }) => void` | — | Called once the upload finishes successfully with the stored key and file. |
| `onProgress` | `(percent: number) => void` | — | Called with the upload progress (0–100) as it advances. |
| `onError` | `(error: Error) => void` | — | Called when validation or the upload fails. |
| `accept` | `string[]` | — | Allowed MIME type patterns; files whose type does not match are rejected. |
| `maxSize` | `number` | — | Maximum file size in bytes; larger files are rejected. |
| `metadata` | `Record<string, string>` | — | Arbitrary metadata to associate with the upload. |
| `disabled` | `boolean` | `false` | Disables interaction and drag-and-drop. |
| `children` | `ReactNode \| (state: UploadZoneRenderProps) => ReactNode` | — | Custom UI, or a render function for full headless control. |

## Headless mode

Pass a render function to bring your own UI while `UploadZone` manages state:

```tsx
<UploadZone onUploadUrl={getUploadUrl} onComplete={handleComplete}>
  {({ getRootProps, getInputProps, isDragging, progress, file }) => (
    <div {...getRootProps()}>
      <input {...getInputProps()} />
      {file ? <p>{progress}%</p> : <p>Drop a video here</p>}
    </div>
  )}
</UploadZone>
```

### UploadZoneRenderProps

| Field | Type | Description |
| --- | --- | --- |
| `getRootProps` | `() => Record<string, unknown>` | Spread onto the drop target element. |
| `getInputProps` | `() => Record<string, unknown>` | Spread onto the hidden `<input type="file">`. |
| `isDragging` | `boolean` | A file is being dragged over the zone. |
| `isUploading` | `boolean` | An upload is in progress. |
| `progress` | `number` | Upload progress, 0–100. |
| `file` | `File \| null` | The currently selected file. |
| `error` | `Error \| null` | The last validation or upload error. |

## See also

- [useUpload](../hooks/use-upload.md) — the hook powering this component, for fully custom flows.
- [Uploads guide](../../guides/uploads.md)
