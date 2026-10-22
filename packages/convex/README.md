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
[Webhook route](#webhook-route)), creates `convex/devultur.ts` with the exposed functions behind a sign-in guard (see
[Guarding the component's functions](#guarding-the-components-functions)), and prints the Convex env
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

## Guarding the component's functions

`defineDevulturFunctions(devultur, { guard })` returns the functions your app exposes to the browser (`createUploadUrl`,
`confirmUpload`, `updateMediaMeta`, `issueViewerToken`, `getMedia`, `listMediaPage`, `deleteMedia`, `deleteVideo`,
`processVideo` and the progress functions), and each one awaits `guard(ctx, { name, kind, args })` before it runs. Throw from the guard to
deny the call. Export the functions your app uses, one by one:

```typescript
// convex/devultur.ts
import { Devultur, defineDevulturFunctions } from "@devultur/convex";
import { ConvexError } from "convex/values";
import { components } from "./_generated/api";

const devultur = new Devultur(components.devultur);

export const { createUploadUrl, confirmUpload, issueViewerToken, getMedia, listMediaPage, deleteMedia } =
  defineDevulturFunctions(devultur, {
    guard: async (ctx, operation) => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) throw new ConvexError("Sign in first");
      // `operation` narrows on `name`: its `args` are that function's arguments.
      if (operation.name === "deleteMedia" && !(await canDelete(ctx, identity, operation.args.key))) {
        throw new ConvexError("You can't delete this file");
      }
      return { userId: identity.subject };
    },
  });
```

- `kind` is `"query"`, `"mutation"` or `"action"`, and `ctx` is that kind's context (every one has `ctx.auth`).
- The guard may return `{ userId }`: `issueViewerToken` then issues the viewer token for that user (its subject)
  instead of the shared `viewer` one. The browser never names it: the exposed function only takes `sessionSecret`.
- `visibility: "internal"` registers them as internal functions, for your own actions and mutations to call.
- `config` takes what `Devultur.exposeApi` does (transcode preset, caption locales, upload lock).
- Each function keeps its arguments and result types, so `api.devultur.confirmUpload` is typed as before and
  `<DevulturProvider api={api.devultur}>` takes them as it takes `exposeApi`'s.

> **`Devultur.exposeApi` has no auth.** It returns the same functions with no guard: anyone who can reach your Convex
> deployment can create upload URLs, confirm uploads, list the whole library and delete media. It keeps working, but
> use it only for a deployment where every caller is trusted, or move to `defineDevulturFunctions`, which takes the
> same `config`.

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

## Multiple workspaces

An app that shows private media from several workspaces (an admin console that previews each one, for example) can
send extra arguments with every viewer token request. Pass them in `tokenArgs`, and pass your own action in
`issueViewerToken`: the component's `issueViewerToken` accepts only `sessionSecret`.

```typescript
// convex/admin.ts
import { v } from "convex/values";
import { components } from "./_generated/api";
import { action } from "./_generated/server";

export const issueWorkspaceViewerToken = action({
  args: { sessionSecret: v.string(), workspaceId: v.id("workspaces") },
  handler: async (ctx, { sessionSecret, workspaceId }) => {
    await assertWorkspaceAccess(ctx, workspaceId); // your own check
    return ctx.runAction(components.devultur.public.issueViewerToken, { sessionSecret });
  },
});
```

```tsx
<DevulturProvider
  api={api.devultur}
  issueViewerToken={api.admin.issueWorkspaceViewerToken}
  tokenArgs={{ workspaceId }}
>
  <WorkspaceMedia />
</DevulturProvider>
```

The provider sends `{ sessionSecret, ...tokenArgs }` on the first issuance, on each renewal and on each re-issue.
`tokenArgs` are compared by value, so a new object with the same values changes nothing. When they change, the
provider drops the current token, private media wait for the new one, and a response for the previous arguments is
ignored. Your action returns what the component's action returns: `{ token, expiresIn }` or the token string.

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

`defineDevulturFunctions` also returns a `listMediaPage` query (`{ type?, paginationOpts }`). It lists every user's
media, so its guard decides who may see the whole library (see
[Guarding the component's functions](#guarding-the-components-functions)).

A record is written only after the Worker confirms the object exists, so an abandoned upload never shows up:

1. After its PUT, the client calls `confirmUpload({ key, filename, width, height })`. The component asks the Worker
   for the object (a `HEAD`) and records its size and content type. `useDevultur().upload()` and `useMediaUpload` do
   this for you when the `api` you pass `<DevulturProvider>` has `confirmUpload` (add it to the functions you export
   from `defineDevulturFunctions` in `convex/devultur.ts`). From your server: `devultur.confirmUpload(ctx, { key })`.
2. `createUploadUrl` also schedules the same check for 25 hours later, past the longest an upload can take. An upload
   whose client never confirmed is recorded then; one that was never stored, or was deleted, isn't.

A record's `key` is the media id for every kind (what `getMedia` takes), and `objectKey` is the uploaded object's key.
`confirmUpload` only accepts upload keys (`{visibility}/{image|file}/{id}/{name}`, `{visibility}/video/{id}/raw/{name}`)
and is idempotent: a video's transcode state stays as it is.

`confirmUpload` runs your guard first, like every function `defineDevulturFunctions` returns. The record's
visibility, size and content type come from the Worker's `HEAD` of the object, never from the arguments; the only
values a caller supplies are the hints described in [Media metadata](#media-metadata).

`deleteMedia` removes an image's or a file's record once the Worker
deleted the object (a delete refused by a lock keeps it). `deleteVideo` removes a video's.

A video only `processVideo` recorded has no `visibility` or `objectKey`, and `mediaFromRecord` returns `null` for
it. `listMedia` doesn't report an object's lock: read it from an action with `devultur.getLock(ctx, record.objectKey)`.

### Media metadata

A record carries what is known about its media. All of these fields are optional, so records and `dv.media()`
references stored before 1.4.0 stay valid without a migration.

| Field | Set by |
| --- | --- |
| `sizeBytes` | The Worker's `HEAD` of the object, on every confirm. |
| `width`, `height` | The Worker, which reads an image's size from its header bytes (PNG, JPEG, GIF, WebP, AVIF) on a single PUT and returns it on `HEAD` (`x-devultur-image-width` / `-height`). Otherwise, the client's hint. |
| `duration` | The transcode, in seconds (`transcode.started` / `transcode.complete`). |
| `pageCount` | The client's hint, recorded for PDFs only. |
| `title`, `alt`, `tags` | Your app, with `updateMediaMeta`. |

**Client hints.** `confirmUpload` accepts `width`, `height` and `pageCount` from the client. They are the uploader's
word, not checked against the bytes: whole numbers from 1 to 100,000, or the call fails with `invalid_media_metadata`.
A size the Worker read wins over the client's. To record a PDF's page count at upload, count it in the browser with
pdf.js (imported on the first call; `pdfjs-dist` must be installed):

```tsx
import { countPdfPages } from "@devultur/convex/pdfjs";

const pageCount = file.type === "application/pdf" ? ((await countPdfPages(file)) ?? undefined) : undefined;
const media = await upload(file, { pageCount });
```

**Editing.** `updateMediaMeta({ key, title?, alt?, tags? })` sets only the fields it's given. Values are trimmed, an
empty `title` or `alt` clears it, and tags are deduplicated (case-insensitively, first spelling kept). Past a title of
200 characters, an alt text of 1,000, or 20 tags of 50 characters each, it fails with `invalid_media_metadata` (its
`details.field` names the field). It returns the updated record, or `null` when no record has that media id.

```typescript
// From the browser: export it from defineDevulturFunctions, so your guard decides who may edit which media.
export const { updateMediaMeta } = defineDevulturFunctions(devultur, { guard });
// From your server:
await devultur.updateMediaMeta(ctx, { key: record.key, title: "Cover", alt: "A mountain at dawn", tags: ["hero"] });
```

`mediaFromRecord(record)` copies the metadata into the reference, and `<Image>` uses `media.alt` when you pass no
`alt`. A stored reference is a copy: after an edit, read the record again (`getMedia`) or store the new reference.

Each write also keeps a `searchText` field (the title and filename, lowercased) with a `search_text` search index over
it, filterable by `type`. Records written before 1.4.0 have no `searchText` until they are written again.

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

### Error messages

`describeDevulturError(error, labels?)` turns an error into a message for your users: a component action's refusal,
a `DevulturApiError` from `@devultur/core`, or a `MediaFetchError` from a preview or download. It returns `null` for
any other error, so your app keeps its own fallback. A code it doesn't know gets the generic `worker_error` message.

`devulturErrorLabels` is the English map, typed `Record<DevulturErrorCode, string | ((details) => string)>`:
`DevulturErrorCode` is the union of every stable code (`DEVULTUR_ERROR_CODES` lists them), and a function label reads
the error's details, such as `file_too_large`'s `limit`. `@devultur/convex/locales/es` exports the Spanish map under
the same name:

```tsx
import { describeDevulturError } from "@devultur/convex";
import { devulturErrorLabels as spanishLabels } from "@devultur/convex/locales/es";

const deleteMedia = useAction(api.devultur.deleteMedia);

try {
  await deleteMedia({ key });
} catch (error) {
  // "Este archivo está protegido hasta el 15 jun 2030 y no se puede modificar ni eliminar antes de esa fecha."
  setMessage(describeDevulturError(error, spanishLabels) ?? "Algo salió mal.");
}
```

A failed browser PUT (`upload()`, `useMediaUpload`) rejects with `UploadHttpError`, which carries the HTTP status
only: match on its `status` for those.

Pass a partial map to change some messages and keep the rest, or a full one for another language (typed
`DevulturErrorLabels`, so a missing code fails to compile):

```ts
describeDevulturError(error, { ...spanishLabels, lock_conflict: "Alguien más acaba de cambiarlo." });
```

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
