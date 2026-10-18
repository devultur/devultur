# @devultur/server

Server SDK for Devultur media: create upload URLs, issue viewer tokens, sign and verify delivery URLs, trigger
transcodes and captions, and handle webhooks. Point it at your self-hosted media Worker, or straight at your own
Cloudflare R2 bucket.

## Install

```bash
pnpm add @devultur/server
```

## Example

```typescript
import { createMediaRouter } from "@devultur/server";

export const media = createMediaRouter({
  baseUrl: "https://media.example.com", // your media Worker
  secret: process.env.WORKER_AUTH_SECRET!, // never ship it to the browser
});

// In an authenticated route: the browser uploads to `url`, you store `key`.
const { url, key } = await media.createUploadUrl({ filename: "lesson-1.mp4", contentType: "video/mp4" });

// A short-lived token that lets this user play private media.
const { token } = await media.issueToken("user_123");
```

Without a Worker, pass `storage` (R2 credentials) and `delivery` (`signSecret`) instead of `baseUrl` and `secret`.
`@devultur/server/node` adds `uploadLargeFile`, a parallel multipart upload of a large file from disk (Node 20+).

## Documentation

Guides and API reference: [github.com/devultur/devultur/tree/main/docs](https://github.com/devultur/devultur/tree/main/docs).

## License

[MIT](https://github.com/devultur/devultur/blob/main/LICENSE)
