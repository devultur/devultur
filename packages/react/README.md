# @devultur/react

React components and hooks for Devultur media: an HLS video player with captions, quality and storyboard
previews, drag-and-drop uploads with progress, an image cropper, transcripts and watch-progress tracking.

## Install

```bash
pnpm add @devultur/react
```

Requires React 19.

## Example

```tsx
import { UploadZone, VideoPlayer } from "@devultur/react";

// `getUploadUrl` calls your backend, which returns `{ url, key }` from `@devultur/server`.
async function getUploadUrl(file: File) {
  const response = await fetch("/api/upload-url", {
    method: "POST",
    body: JSON.stringify({ filename: file.name, contentType: file.type }),
  });
  return response.json() as Promise<{ url: string; key: string }>;
}

export function Lesson({ playlistUrl, viewerToken }: { playlistUrl: string; viewerToken: string }) {
  return (
    <>
      <UploadZone onUploadUrl={getUploadUrl} onComplete={({ key }) => console.log("uploaded", key)} />
      <VideoPlayer src={playlistUrl} token={viewerToken} />
    </>
  );
}
```

## Documentation

Components, hooks and guides: [github.com/devultur/devultur/tree/main/docs](https://github.com/devultur/devultur/tree/main/docs).

## License

[MIT](https://github.com/devultur/devultur/blob/main/LICENSE)
