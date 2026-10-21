# @devultur/convex

[Convex](https://convex.dev) component for Devultur media: stores media records and watch progress in isolated
tables, exposes upload, token, transcode and delete functions for your app, serves the transcode webhook route, and
ships typed validators and React bindings.

## Install

```bash
pnpm add @devultur/convex
pnpm exec devultur-init
```

`devultur-init` adds the component to `convex/convex.config.ts` (mounted with `httpPrefix: "/devultur/"`, see
[Webhook route](#webhook-route)), creates `convex/devultur.ts` with the exposed functions, and prints the Convex env
vars to set (your media Worker's URL and credential).

## Webhook route

The component receives transcode and captions events on its own HTTP route, `POST /webhook`. Convex serves a
component's HTTP routes only when the app mounts the component with an `httpPrefix`:

```typescript
// convex/convex.config.ts
app.use(devultur, { httpPrefix: "/devultur/", env: { /* see below */ } });
```

With that prefix the route is `https://<deployment>.convex.site/devultur/webhook`. You don't need an `http.ts` entry
for it. `processVideo` sends the Worker that URL as the `callbackUrl`, and it follows the prefix you choose (with
`httpPrefix: "/media/"` it is `https://<deployment>.convex.site/media/webhook`).

Without `httpPrefix` the route doesn't exist: the Worker's events get `404`, the media record never leaves
`queued`, and every transcode fails with a timeout.

## Example

```typescript
// convex/schema.ts
import { dv } from "@devultur/convex";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  courses: defineTable({
    title: v.string(),
    thumbnail: dv.media("image").optional(), // a typed media reference, not a URL
  }),
});
```

```tsx
// React
import { DevulturProvider, Image, useDevultur } from "@devultur/convex/react";
import { api } from "../convex/_generated/api";

<DevulturProvider api={api.devultur}>
  <App />
</DevulturProvider>;

function CourseCover({ course }) {
  return <Image media={course.thumbnail} alt={course.title} width={512} format="webp" />;
}

function CoverUpload({ onSaved }) {
  const { upload } = useDevultur();
  return <input type="file" onChange={async (event) => onSaved(await upload(event.target.files![0]))} />;
}
```

## Upload progress

`upload(file, { onProgress, signal })` reports the PUT's progress and resolves to the stored reference:

```tsx
const { upload } = useDevultur();

const media = await upload(file, {
  onProgress: ({ loadedBytes, totalBytes, fraction }) => setPercent(Math.round(fraction * 100)),
  signal: controller.signal, // aborts the PUT; upload() rejects with an AbortError
});
media.key; // the uploaded object's key ("private/image/<id>/<name>"; a video's raw file)
await saveCover({ cover: media }); // a DevulturMedia: stores as-is in a dv.media() field, key included
```

The PUT goes through `XMLHttpRequest` (`fetch` reports no upload progress), in parts for large files. `key` is an
optional field of `DevulturMedia` and of `dv.media()`. It is informational: delivery URLs are derived from `id`,
`kind`, `visibility` and `filename`.

## Media library

Every upload, whatever its kind, gets a record in the component's `media` table once its bytes are stored, so
`listMedia` lists your images, files and videos:

```typescript
// convex/library.ts
import { Devultur, mediaFromRecord } from "@devultur/convex";
import { query } from "./_generated/server";
import { components } from "./_generated/api";

const devultur = new Devultur(components.devultur);

export const images = query({
  args: {},
  handler: async (ctx) => {
    // Check who's asking first: listMedia returns every record, of every user.
    const records = await devultur.listMedia(ctx, { type: "image" }); // or "video" | "file", or no filter
    return records.map((record) => ({ record, media: mediaFromRecord(record) }));
  },
});
```

`listMedia` reads every record at once: fine for a handful, unbounded for a library. Page a library with
`listMediaPage`, newest first, on a `by_type` index:

```typescript
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

export const imagesPage = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    // Check who's asking first.
    return devultur.listMediaPage(ctx, { type: "image", paginationOpts });
  },
});
// React: usePaginatedQuery(api.library.imagesPage, {}, { initialNumItems: 24 })
```

`Devultur.exposeApi` also returns a `listMediaPage` query (`{ type?, paginationOpts }`). It lists every user's media,
so export it only when every caller may see the whole library.

A record is written only after the Worker confirms the object exists, so an abandoned upload never shows up:

1. After its PUT, the client calls `confirmUpload({ key, filename, width, height })`. The component asks the Worker
   for the object (a `HEAD`) and records its size and content type. `useDevultur().upload()` and `useMediaUpload` do
   this for you when the `api` you pass `<DevulturProvider>` has `confirmUpload` (add it to the functions you export
   from `Devultur.exposeApi` in `convex/devultur.ts`). From your server: `devultur.confirmUpload(ctx, { key })`.
2. `createUploadUrl` also schedules the same check for 25 hours later, past the longest an upload can take. An upload
   whose client never confirmed is recorded then; one that was never stored, or was deleted, isn't.

A record's `key` is the media id for every kind (what `getMedia` takes), and `objectKey` is the uploaded object's key.
`confirmUpload` only accepts upload keys (`{visibility}/{image|file}/{id}/{name}`, `{visibility}/video/{id}/raw/{name}`)
and is idempotent: a video's transcode state stays as it is.

`confirmUpload`, like every function `exposeApi` returns (and the `devultur-init` template exports), has no auth of
its own: anyone who can call your Convex deployment can call it. Wrap it with your app's auth, as you would the other
exposed functions: export your own action that checks `ctx.auth` and then calls `devultur.confirmUpload(ctx, { key })`.
The caller only names the key: the record's visibility, size and content type come from the Worker's `HEAD` of the
object, never from the arguments.

`deleteMedia` removes an image's or a file's record once the Worker
deleted the object (a delete refused by a lock keeps it). `deleteVideo` removes a video's.

A video only `processVideo` recorded has no `visibility` or `objectKey`, and `mediaFromRecord` returns `null` for
it. `listMedia` doesn't report an object's lock: read it from an action with `devultur.getLock(ctx, record.objectKey)`.

## Using a self-hosted Worker

The component talks to any Worker built with `createWorker()` from
[`@devultur/self-host`](https://github.com/devultur/devultur/tree/main/packages/self-host) (see the
[self-host guide](https://github.com/devultur/devultur/blob/main/docs/guides/self-host.md)). It needs two values:

| Convex env var | Value |
| --- | --- |
| `DEVULTUR_API_URL` | The Worker's origin, without a trailing slash, for example `https://media.example.com` |
| `DEVULTUR_SECRET` | The Worker's `WORKER_AUTH_SECRET`, the same string you set with `wrangler secret put` |

Declare both in your app and bind them to the component. Convex rejects `app.env.<NAME>` for a name that
`defineApp()` doesn't declare:

```typescript
// convex/convex.config.ts
import devultur from "@devultur/convex/convex.config";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({ env: { DEVULTUR_SECRET: v.string(), DEVULTUR_API_URL: v.string() } });
app.use(devultur, {
  httpPrefix: "/devultur/",
  env: { DEVULTUR_SECRET: app.env.DEVULTUR_SECRET, DEVULTUR_API_URL: app.env.DEVULTUR_API_URL },
});

export default app;
```

```bash
npx convex env set DEVULTUR_API_URL https://media.example.com
npx convex env set DEVULTUR_SECRET <the Worker's WORKER_AUTH_SECRET>
```

**Webhooks.** Keep the `httpPrefix` in `app.use()`: without it Convex doesn't serve the component's route and every
transcode times out (see [Webhook route](#webhook-route)). Nothing else needs configuring. `processVideo` sends the
Worker a `callbackUrl` that points at the component's route, `https://<deployment>.convex.site/devultur/webhook`
(your app's `CONVEX_SITE_URL` followed by the prefix and `webhook`). The transcode runner reports to the Worker with
`TRANSCODE_WEBHOOK_SECRET`. The Worker then forwards each event to the `callbackUrl` with
`Authorization: Bearer <WORKER_AUTH_SECRET>`. The component accepts an event only when that bearer equals
`DEVULTUR_SECRET`. If `DEVULTUR_SECRET` is wrong or missing, the component answers `401` to every event. Keep
`TRANSCODE_WEBHOOK_SECRET` on the Worker only: the component never needs it.

If you replace the Worker's `workerSecretAuth()` plugin with an auth plugin of your own, the Worker forwards
webhooks with the `webhookCredential` your plugin sets in the request state (or `runnerCredential` when it sets
none; see [Plugins](https://github.com/devultur/devultur/blob/main/docs/guides/plugins.md)). Set `DEVULTUR_SECRET`
to that value, and make sure your plugin also accepts it as the bearer of the component's calls.

## Errors

When the media Worker refuses a request, component actions throw a `ConvexError` whose `data` is
`{ code, message, status, details? }`. A plain `Error` would lose these fields across the component boundary. `code` is
the Worker's stable code: for example `retention_active`, `compliance_extend_only`, `lock_conflict`,
`lock_privilege_required`, `file_too_large`, or `worker_error` when the Worker sent none. `details` carries the rest of
the Worker's answer, such as the `{ key, mode, until, hold }` of a `retention_active`.

```ts
import { devulturErrorOf } from "@devultur/convex";

try {
  await devultur.setLock(ctx, key, { until });
} catch (error) {
  const refusal = devulturErrorOf(error); // null when it isn't a Worker refusal
  if (refusal?.code === "compliance_extend_only") {
    // the date can only move later
  }
  throw error;
}
```

`isDevulturError(error)` is the matching type guard. Errors that aren't Worker refusals, such as a network failure,
are rethrown unchanged.

## Object lock

- `devultur.createUploadUrl(ctx, { filename, contentType, lock, hold })` locks a file from its first write.
- `devultur.getLock(ctx, key)` and `devultur.setLock(ctx, key, { mode, until, period, derivatives })` read and change
  a file's retention.
- `devultur.setHold(ctx, keys)` and `devultur.releaseHold(ctx, keys)` set and release holds.

These are server-side calls: `exposeApi` never lets a browser choose or change a lock. Its `createUploadUrl` applies
`config.upload.lock` instead. A bulk hold by prefix runs on your server with `@devultur/core`'s
`createWorkerClient(...).lock.holdAll({ prefix })`. The
[Retention and holds](https://github.com/devultur/devultur/blob/main/docs/guides/object-lock.md) guide covers the model,
what's enforced and the caveats.

## Documentation

Guides and API reference: [github.com/devultur/devultur/tree/main/docs](https://github.com/devultur/devultur/tree/main/docs).

## License

[MIT](https://github.com/devultur/devultur/blob/main/LICENSE)
