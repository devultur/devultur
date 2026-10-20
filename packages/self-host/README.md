# @devultur/self-host

The Devultur media Worker: a [Hono](https://hono.dev) app for Cloudflare Workers that handles uploads (single and
multipart, straight to R2), public and private delivery with an edge cache, image transforms, single-use download
links, encryption at rest, HLS transcode (Cloudflare Containers, Fly Machines or your own HTTP runner) and captions.

## Install

```bash
pnpm add @devultur/self-host
```

## Example

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

[[r2_buckets]]
binding = "KEYS_BUCKET" # per-object encryption keys: required when security.encrypt is on
bucket_name = "my-media-keys"

[[kv_namespaces]]
binding = "MEDIA_KV" # pending uploads and transcode job state
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
wrangler r2 bucket create my-media-keys        # keep it private and backed up
wrangler secret put DELIVERY_SIGN_SECRET       # signs viewer tokens and links
wrangler secret put WORKER_AUTH_SECRET         # your backend's bearer on control routes
wrangler secret put TRANSCODE_WEBHOOK_SECRET   # signs transcode callbacks
wrangler deploy
```

Without its secrets the Worker fails closed: control routes answer `503`. With encryption at rest on and no
`KEYS_BUCKET`, private writes answer `503 keys_bucket_missing` instead of storing plaintext. Call it from your backend with
[`@devultur/server`](https://www.npmjs.com/package/@devultur/server). The Worker is built from plugins:
`createWorker({ plugins })` takes your rules, your own auth, hooks before a credential is issued, and routes and
middleware of your own.

## Documentation

- Self-host guide (routes, rules, transcode runners, image transforms):
  [github.com/devultur/devultur/blob/main/docs/guides/self-host.md](https://github.com/devultur/devultur/blob/main/docs/guides/self-host.md).
- Plugins (auth, request state, hooks, example plugins):
  [github.com/devultur/devultur/blob/main/docs/guides/plugins.md](https://github.com/devultur/devultur/blob/main/docs/guides/plugins.md).
- Retention and holds (compliance and governance locks, holds, audit, caveats):
  [github.com/devultur/devultur/blob/main/docs/guides/object-lock.md](https://github.com/devultur/devultur/blob/main/docs/guides/object-lock.md).

## License

[AGPL-3.0-only](https://github.com/devultur/devultur/blob/main/packages/self-host/LICENSE)
