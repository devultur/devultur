# Devultur

Media infrastructure you run on your own Cloudflare account. Upload, store, transcode, caption, transform and
deliver video, images and files from [R2](https://developers.cloudflare.com/r2/), with typed SDKs for your backend
and your React app.

- **Uploads** straight from the browser to R2 (presigned, multipart for large files), with per-type size and type
  rules.
- **Video**: adaptive HLS transcode with FFmpeg on Cloudflare Containers, Fly Machines or your own server, plus
  captions and storyboards.
- **Images**: on-the-fly resize and format negotiation (AVIF, WebP, JPEG), each variant computed once and cached in
  your bucket.
- **Private delivery**: short-lived viewer tokens bound to a session, single-use download links, and optional
  encryption at rest (AES-CTR for files, AES-128 HLS for video).
- **React components**: `VideoPlayer`, `UploadZone`, captions, transcripts and progress tracking.

## Packages

| Package | What it is | License |
| --- | --- | --- |
| [`@devultur/self-host`](packages/self-host) | The media Worker (Hono on Cloudflare Workers): uploads, delivery, transcode, captions, image transforms | AGPL-3.0-only |
| [`@devultur/core`](packages/core) | Config, types, storage path conventions, media references, the Worker client | MIT |
| [`@devultur/server`](packages/server) | Server SDK: `createMediaRouter`, presigned URLs, signed delivery, webhook handlers | MIT |
| [`@devultur/react`](packages/react) | React components and hooks: video player, uploads, captions, progress | MIT |
| [`@devultur/convex`](packages/convex) | [Convex](https://convex.dev) component, validators and React bindings | MIT |

[`infra/transcode`](infra/transcode) holds the transcode image (Alpine + FFmpeg) and a reference HTTP runner.

## Quick start

### 1. Deploy the media Worker

Create a Worker project that depends on `@devultur/self-host`:

```typescript
// src/index.ts
import { createWorker } from "@devultur/self-host";
export { DownloadLink } from "@devultur/self-host";

export default createWorker();
```

```toml
# wrangler.toml
name = "media"
main = "src/index.ts"
compatibility_date = "2026-10-01"

[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "my-media"

[[kv_namespaces]]
binding = "MEDIA_KV"   # the Worker's state store: pending uploads, transcode jobs
id = "<your KV namespace id>"

[[durable_objects.bindings]]
name = "DOWNLOAD_LINKS"
class_name = "DownloadLink"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["DownloadLink"]
```

```bash
wrangler r2 bucket create my-media
wrangler kv namespace create media-state
wrangler secret put DELIVERY_SIGN_SECRET       # openssl rand -base64 32, signs viewer tokens and links
wrangler secret put WORKER_AUTH_SECRET         # openssl rand -base64 32, your backend's bearer
wrangler secret put TRANSCODE_WEBHOOK_SECRET   # openssl rand -base64 32, signs transcode callbacks
wrangler deploy
```

Without its secrets the Worker fails closed: control routes answer `503`, never open access. To transcode video,
pick a runner (Cloudflare Containers is the simplest); see the [self-host guide](docs/guides/self-host.md).

### 2. Call it from your backend

```typescript
import { createMediaRouter } from "@devultur/server";

export const media = createMediaRouter({
  baseUrl: "https://media.example.com",
  secret: process.env.WORKER_AUTH_SECRET!, // never ship it to the browser
});

const { url, id, kind, visibility } = await media.createUploadUrl({
  filename: "lesson-1.mp4",
  contentType: "video/mp4",
});
```

### 3. Upload and play in React

```tsx
import { UploadZone, VideoPlayer } from "@devultur/react";

<UploadZone onUploadUrl={getUploadUrl} onComplete={(result) => save(result)} />;
<VideoPlayer src={playlistUrl} token={viewerToken} />;
```

Using Convex? `@devultur/convex` wraps all of this in a component with typed validators and hooks.

## Documentation

The guides in [`docs/`](docs) cover the Worker and the SDKs:

- [Self-host the media Worker](docs/guides/self-host.md)
- [Uploads](docs/guides/uploads.md) · [Media references & delivery](docs/guides/media-references.md)
- [Video processing](docs/guides/video-processing.md) · [Video player](docs/guides/video-player.md)
- [Progress tracking](docs/guides/progress-tracking.md) · [Security](docs/guides/security.md)
- [Framework examples](docs/guides/framework-examples.md) · [React components and hooks](docs/react)

## Development

```bash
pnpm install
pnpm build
pnpm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md); contributors sign a one-time
[Contributor License Agreement](CLA.md).

## License

The SDKs (`core`, `server`, `react`, `convex`) are MIT. The media Worker (`self-host`) is AGPL-3.0-only. See
[LICENSE](LICENSE).
