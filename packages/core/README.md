# @devultur/core

Shared building blocks of the Devultur SDKs: config and types, storage path conventions, media references, URL
signing, and a typed client for the self-hosted media Worker. It has no runtime dependencies and runs in Node,
browsers and Workers.

Most apps use it through [`@devultur/server`](https://www.npmjs.com/package/@devultur/server) or
[`@devultur/react`](https://www.npmjs.com/package/@devultur/react); install it directly when you need the
primitives.

## Install

```bash
pnpm add @devultur/core
```

## Example

```typescript
import { buildMediaUrl, createWorkerClient } from "@devultur/core";

// Talk to your media Worker from a backend. Never ship the secret to the browser.
const worker = createWorkerClient(process.env.WORKER_AUTH_SECRET!, "https://media.example.com");

// The browser PUTs the file to `url`; keep `key` to serve it later.
const { url, key } = await worker.createUploadUrl({ filename: "cover.jpg", contentType: "image/jpeg" });
const { token } = await worker.issueToken("user_123");

// Resized, format-negotiated image URL for a private object.
const src = buildMediaUrl("https://media.example.com", key, { token, width: 640, format: "webp" });
```

`worker.lock` reads and changes a file's retention and holds (`get`, `set`, `hold`, `release`, `holdAll`,
`releaseAll`), and a refusal surfaces as a `DevulturApiError` with its `code` and `details`. See
[Retention and holds](https://github.com/devultur/devultur/blob/main/docs/guides/object-lock.md).

## Documentation

Guides and API reference: [github.com/devultur/devultur/tree/main/docs](https://github.com/devultur/devultur/tree/main/docs).
The [retention and holds guide](https://github.com/devultur/devultur/blob/main/docs/guides/object-lock.md) ships with
the package, for the installed version: `node_modules/@devultur/core/docs/guides/object-lock.md`.

## License

[MIT](https://github.com/devultur/devultur/blob/main/LICENSE)
