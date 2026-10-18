# Uploads

Generate presigned upload URLs and use the UploadZone component — styled or headless.

Uploads go straight from the browser to R2 using a short-lived presigned URL that
your server generates. Your backend never handles the file bytes.

## Presigned URLs

```typescript
// Server: generate upload URL
const { url, id, kind, visibility } = await media.createUploadUrl({
  filename: "lesson1.mp4",
  contentType: "video/mp4",
});

// Client: upload the file (no auth needed — presigned URL)
await fetch(url, {
  method: "PUT",
  headers: { "Content-Type": file.type },
  body: file,
});

// Store a typed reference — this is what you persist, transcode, deliver, and render.
const video = { id, kind, visibility, filename: "lesson1.mp4" };
```

`createUploadUrl` returns the resolved `id`, `kind`, and `visibility`. Together with
the filename they form a **`DevulturMedia`** reference. Store the reference, not a
URL: the delivery path is derived from it, so it never goes stale. See [Media
references & delivery](media-references.md).

## Visibility

`visibility` defaults per type from your router config; override it per upload:

```typescript
// A private course workbook, regardless of the router default:
const workbook = await media.createUploadUrl({
  filename: "module-1.pdf",
  contentType: "application/pdf",
  visibility: "private",
});
```

Resolution order: **upload override → router default → `private`**. Nothing is
public without an explicit decision.

## UploadZone component

`UploadZone` handles drag-and-drop, progress, and the presigned PUT for you:

```tsx
import { UploadZone } from "@devultur/react";

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
