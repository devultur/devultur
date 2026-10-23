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

## Playback metrics

`<VideoPlayer>` sends playback quality metrics **by default**: startup time, rebuffering, errors, bitrate and watch
time, in small beacons to `POST /v1/metrics/playback` on the host that serves the video (Devultur delivery URLs
only). They're anonymous: a random id per view, the media key and counters. No cookies, no local storage and no user
id. The self-host Worker discards them unless a plugin records them.

Turn them off with `metrics={false}`:

```tsx
<VideoPlayer src={playlistUrl} token={viewerToken} metrics={false} />
```

Every field and when it's sent:
[docs/guides/video-player.md#playback-metrics](https://github.com/devultur/devultur/blob/main/docs/guides/video-player.md#playback-metrics),
also shipped with the package as `node_modules/@devultur/react/docs/guides/video-player.md`.

## Labels

`<VideoPlayer labels={…}>` replaces any of the player's strings (`VideoPlayerLabels`); the rest stay English.
`@devultur/convex/locales/es` and `locales/es-formal` export Spanish ones as `videoPlayerLabels`.

## Documentation

Components, hooks and guides: [github.com/devultur/devultur/tree/main/docs](https://github.com/devultur/devultur/tree/main/docs).
The [video player guide](https://github.com/devultur/devultur/blob/main/docs/guides/video-player.md) ships with the
package, for the installed version: `node_modules/@devultur/react/docs/guides/video-player.md`.

## License

[MIT](https://github.com/devultur/devultur/blob/main/LICENSE)
