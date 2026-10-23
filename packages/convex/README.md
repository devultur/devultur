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
`confirmUpload`, `updateMediaMeta`, `issueViewerToken`, `getMedia`, `listMediaPage`, `searchMedia`, `deleteMedia`,
`deleteVideo`, `processVideo` and the progress functions), and each one awaits `guard(ctx, { name, kind, args })` before
it runs. Throw from the guard to deny the call. `listMediaPage`, `searchMedia` and `updateMediaMeta` are library-wide:
they read or edit every user's media, so the guard decides who may call them. Export the functions your app uses, one
by one:

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
- That `userId` is also the only user the progress functions (`saveProgress`, `loadProgress`, `markComplete`,
  `resetProgress`) act for: a call whose `userId` is another user's is refused with `user_mismatch` (403), so a
  signed-in user can't read or overwrite someone else's progress. Return `{ userId, canActForOthers: true }` for a
  caller who may (an admin resetting a learner's progress). A guard that returns no `userId` keeps the browser's, as
  `exposeApi` does: return one whenever the progress functions are exported.
- The guard may also return a `rewrite`, `{ name, args }`: each key of `args` replaces the caller's argument of that
  name, on your server, before the function runs (see [Upload visibility](#upload-visibility)). `name` is the guarded
  operation's, so `args` are typed for it; a rewrite named for another operation throws. The rewritten arguments
  aren't validated again.
- `visibility: "internal"` registers them as internal functions, for your own actions and mutations to call.
- `config` takes what `Devultur.exposeApi` does (transcode preset, caption locales, upload lock and default
  visibility).
- Each function keeps its arguments and returns the component's result, typed: with no annotation,
  `useQuery(api.devultur.getMedia, { key })` is a `MediaDocument | null` (a `MediaRecord` with its `_id` and
  `_creationTime`), and `listMediaPage` and `searchMedia` are a `PaginationResult<MediaDocument>`.
  `DevulturFunctionResults` names every function's result. `<DevulturProvider api={api.devultur}>` takes them as it
  takes `exposeApi`'s, whose results are the same.

> **`Devultur.exposeApi` has no auth.** It returns the same functions with no guard: anyone who can reach your Convex
> deployment can create upload URLs, confirm uploads, list the whole library and delete media. It keeps working, but
> use it only for a deployment where every caller is trusted, or move to `defineDevulturFunctions`, which takes the
> same `config`.

## Upload visibility

`config.upload.visibility` sets the visibility of an upload whose caller passes none. Without it, the Worker's default
by type applies.

```typescript
export const { createUploadUrl, confirmUpload } = defineDevulturFunctions(devultur, {
  guard,
  config: { upload: { visibility: "public" } }, // a site whose uploads are public unless the browser asks otherwise
});
```

The browser can still pass `visibility` (`upload(file, { visibility })`, `useMediaUpload({ visibility })`). To decide
it on your server instead, rewrite it in the guard: the guard's `rewrite` replaces the browser's arguments.

```typescript
guard: async (ctx, operation) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Sign in first");
  // Members' uploads are always private, whatever the browser asked for.
  if (operation.name === "createUploadUrl") {
    return { userId: identity.subject, rewrite: { name: "createUploadUrl", args: { visibility: "private" } } };
  }
  return { userId: identity.subject };
},
```

Which one wins, from first to last:

1. The guard's `rewrite.args.visibility`.
2. The caller's `visibility`.
3. `config.upload.visibility`.
4. The Worker's default by type.

The guard sees the caller's arguments as they arrived (`operation.args.visibility` is `undefined` when the browser
passed none): the config's default is applied after the guard. `config.upload.lock` isn't an argument, so neither
the browser nor the guard's `rewrite` change it.

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

### Display-only apps

An app that only shows media (no uploads, no deletes) uses `<DevulturViewerProvider>`, which needs only the base URL
and, for private media, a viewer token action:

```tsx
import { DevulturViewerProvider, Preview } from "@devultur/convex/react";

<DevulturViewerProvider
  baseUrl={MEDIA_URL}
  issueViewerToken={api.admin.issueWorkspaceViewerToken}
  tokenArgs={{ workspaceId }}
>
  <Preview media={document.file} />
</DevulturViewerProvider>;
```

`<Image>`, `<Preview>`, `<PdfThumbnail>`, `<DownloadLink>`, `<DocumentLink>`, `<AttachmentCard>`, `useMediaObjectUrl`,
`useMediaUrl` and `useVideoProps` work under it. `useDevultur().upload`, `uploadUrl` and `deleteMedia`, and the hooks
that need the `api` (`useDevulturApi`, `useMediaUpload`, `<MediaLibrary>`, `<MediaPicker>`), throw a
`DevulturCapabilityError` whose `code` is `capability_unavailable`.

Like `<DevulturProvider>`, it issues the viewer token as soon as it mounts. With `lazyToken`, it issues it only when
a private media is shown, and renews it from then on: while every media on the page is public, it calls nothing,
`tokenStatus` stays `"idle"` and `token` stays `null`. Code that reads `token` itself then calls
`useDevultur().requestToken()` first; the built-in components and hooks do it for private media.

```tsx
<DevulturViewerProvider baseUrl={MEDIA_URL} issueViewerToken={api.devultur.issueViewerToken} lazyToken>
  <Gallery />
</DevulturViewerProvider>
```

When all the media is public, leave `issueViewerToken` out. The provider then needs no Convex client and issues
nothing:

```tsx
<DevulturViewerProvider baseUrl={MEDIA_URL}>
  <Image media={post.cover} alt={post.title} />
</DevulturViewerProvider>
```

A private media shown under it fails with `token_unavailable`, and `tokenError` says the provider has no
`issueViewerToken`.

### Components outside a provider

`useDevultur()` throws outside `<DevulturProvider>` and `<DevulturViewerProvider>`. A component that also renders
without one uses `useDevulturOptional()`, which returns the same value, or `null` outside both:

```tsx
function Avatar({ media, fallbackUrl }) {
  const devultur = useDevulturOptional();
  if (!devultur || !media) return <img src={fallbackUrl} alt="" />;
  return <Image media={media} alt="" width={64} />;
}
```

`useDevulturOptional()` is non-null under a `<DevulturProvider>` given no `baseUrl` too, where the hooks that build
URLs throw. `useCanDeliver()` answers that instead: `true` only under a provider with a non-empty `baseUrl`.

```tsx
function Cover({ media, fallbackUrl }) {
  if (!useCanDeliver() || !media) return <img src={fallbackUrl} alt="" />;
  return <Image media={media} alt="" />;
}
```

Public media needs nothing more. Private media also needs the viewer token, which a provider may not have yet
(`lazyToken`) or can't issue (a `<DevulturViewerProvider>` without `issueViewerToken`); `tokenStatus` from
`useDevultur()` tells, and the components show their error state when it fails.

### Only the hooks

`@devultur/convex/react/hooks` exports the contexts and the hooks that only read them, without the components or
Convex's client: `useDevultur`, `useDevulturOptional`, `useCanDeliver`, `useDevulturApi`, `useDevulturProgress`,
`useMediaUrl`, `useVideoProps`, and the `DevulturContext`, `DevulturApiContext` and `DevulturProgressContext` objects.
The contexts and the hooks that only read them sit in a chunk of their own, apart from `useMediaUrl`, `useVideoProps`
and `@devultur/core`'s URL helpers, so a shared component that only checks for a provider adds under 0.5 kB gzipped,
even to the entry of an app that lazy-loads `@devultur/convex/react` on a route:

```tsx
import { useDevulturOptional } from "@devultur/convex/react/hooks";
```

They're the very objects `@devultur/convex/react` exports, so a `<DevulturProvider>` or `<DevulturViewerProvider>`
imported from there fills them. The hooks that call your Convex functions (`useDevulturMedia`, `useVideoState`,
`useMediaUpload`, `useMediaLibrary`) stay in `@devultur/convex/react`, with the components.

### When the viewer token can't be issued

`useDevultur()` tells where the viewer token stands:

```tsx
const { tokenStatus, tokenError, retryToken } = useDevultur();
// tokenStatus: "idle" (not asked for yet) | "loading" | "ready" | "error"
if (tokenStatus === "error") return <button onClick={retryToken}>Try again</button>; // tokenError has why
```

The status turns `"error"` when the action throws (your guard refused, for example) or returns no token, and stays
there until `retryToken()`: a failed issuance isn't retried on its own. Meanwhile private media fails at once with the
`MediaFetchError` code `token_unavailable` instead of loading: `useMediaObjectUrl` returns it as `error`,
`<Preview>` passes it to its `fallback`, `<PdfThumbnail>` and `<Image>` render their `fallback` (`<Image onLoadError>`
receives it), and `<DownloadLink onDownloadError>` receives it on click. They load once `retryToken()` gets a token.

`<Preview>`'s video plays in `<VideoPlayer>` from `@devultur/react`, with its playback metrics on: anonymous, no
cookies, sent to the media host (see [Playback metrics](https://github.com/devultur/devultur/blob/main/docs/guides/video-player.md#playback-metrics),
also in `node_modules/@devultur/convex/docs/guides/video-player.md`).
`<Preview metrics={false}>` turns them off. A private video shows `loading` until its viewer token is issued.

`<Preview>`'s video re-issues the token once when the delivery answers the playlist or a segment with a 401
`session_mismatch`; after that, or on any other 401, it renders its `fallback` with `session_mismatch` or
`token_unavailable`. `<VideoPlayer onError>` (from `@devultur/react`) reports these failures when you render the
player yourself.

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
word, not checked against the bytes: whole numbers from 1 to 100,000. Another value is dropped (with a warning in the
logs) and the upload is recorded without it: the bytes are already stored.
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
it, filterable by `type`. Records written before 1.4.0 get theirs from [the backfill](#records-from-before-140) or
from their next write.

### Searching the library

`searchMedia({ search, type?, paginationOpts })` pages through the records whose title or filename matches `search`,
best match first, optionally of one type. Convex's full-text search matches whole words, and the last word as a
prefix (`cov` finds "Cover photo"). A blank `search` lists the library newest first, like `listMediaPage`.

```typescript
// Behind your guard: like listMediaPage, it searches every user's media.
export const { listMediaPage, searchMedia } = defineDevulturFunctions(devultur, { guard });
// From your server:
await devultur.searchMedia(ctx, { search: "cover", type: "image", paginationOpts });
```

#### Records from before 1.4.0

Records written before 1.4.0 have no `searchText`, so `searchMedia` doesn't find them (`listMediaPage` still lists
them). Any write to one gives it its `searchText` (a transcode update, a confirmed upload, `updateMediaMeta`). To fill
them all at once, run the backfill once after upgrading. It fills 100 records per mutation and schedules the next
batch until it reaches the end of the table; running it again only fills what is still missing.

```bash
npx convex run --component devultur library:backfillSearchText '{}'
```

Or from a function of your own, for example an internal mutation you run from the dashboard:

```typescript
// convex/maintenance.ts
import { internalMutation } from "./_generated/server";

export const backfillMediaSearch = internalMutation({
  args: {},
  // { updated, isDone }: the first batch's count, and false while more batches are scheduled.
  handler: async (ctx) => devultur.backfillSearchText(ctx, { batchSize: 200 }), // 1 to 1000, default 100
});
```

### React: `useMediaLibrary` and `<MediaLibrary>`

Both read the library through the `listMediaPage` and `searchMedia` you pass `<DevulturProvider api>`.

`useMediaLibrary({ type?, search?, pageSize? })` wraps Convex's `usePaginatedQuery`. It waits until `search` has
stayed the same for 250 ms before querying (clearing it applies at once), and a new search or type starts again from
the first page.

```tsx
import { useMediaLibrary } from "@devultur/convex/react";

const { items, status, loadMore, isLoading, isSearchPending } = useMediaLibrary({ type: "image", search, pageSize: 24 });
// status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted"; loadMore() loads pageSize more.
```

Like `usePaginatedQuery`, a query that fails (your guard throws, for example) throws during render to the nearest
error boundary. `<MediaLibrary>` has its own.

`<MediaLibrary>` is a grid with a search box and a type filter. Images show a 160 px thumbnail (`<Image widths>`,
`format: "auto"`); other media show an icon, and every item shows its title (or filename) and size.

```tsx
import { MediaLibrary } from "@devultur/convex/react";

<MediaLibrary type="image" selectable onSelect={(record, media) => setCover(media)} />;
```

| Prop | |
| --- | --- |
| `onSelect(record, media)` | Called on a click, Enter or Space. `media` is `mediaFromRecord(record)`, `null` for a record without a visibility. |
| `type` | Only this type; the type filter is hidden. |
| `selectable` | Keeps the chosen item selected (`aria-selected`, `data-selected`), for a picker. Default `false`. |
| `selectedKeys` | The selected records' keys (media ids), controlled: shown as selected instead of the last one chosen. Implies `selectable`. |
| `multiple` | Several items can be selected (`aria-multiselectable`), with `selectedKeys`. |
| `filter(record)` | Shows only the records it returns `true` for, of each loaded page (a page can then show fewer items). |
| `renderItem(record, { media, isSelected, isActive })` | Replaces an item's content; the item stays the focusable option. |
| `pdfThumbnails` | Draws page 1 of PDFs with `<PdfThumbnail>` (inside a `PdfPreviewProvider`). Off by default, because each thumbnail downloads its PDF. |
| `pageSize` | Records per page. Default 24. |
| `labels` | Any of the strings below. |
| `className`, `classNames` | Added to the root's and each part's class. |

The items are a `listbox` of `option`s with one tab stop: the arrow keys move between them (up and down by a row of the
grid), Home and End go to the first and last. While the first page loads, the library is empty, or nothing matches,
a `role="status"` message replaces the grid. A failed query shows `labels.error(error)` in a `role="alert"` with a
retry button; by default, a Devultur error's message (see [Error messages](#error-messages)).

The component sets only its layout. Each part has a class (`devultur-media-library`, and
`devultur-media-library__{search,filter,list,item,thumbnail,name,size,status,more}`), and these custom properties
tune the grid: `--devultur-library-item-width` (160px, the narrowest column), `--devultur-library-gap` (0.75rem),
`--devultur-library-item-gap` (0.25rem), `--devultur-library-thumbnail-height` (120px) and
`--devultur-library-accent` (`currentColor`, the selected item's ring).

The strings are English by default; `@devultur/convex/locales/es` exports Spanish ones:

```tsx
import { mediaLibraryLabels } from "@devultur/convex/locales/es";

<MediaLibrary labels={mediaLibraryLabels} onSelect={handleSelect} />;
```

## Media picker

`<MediaPicker>` is what a content editor uses to fill a media field: it uploads new files (with progress, cancel and
retry), browses and searches the library (`<MediaLibrary>`), and shows the selection (`<AttachmentCard>`, with an
inline `<Preview>`). It returns `DevulturMedia` references through `onChange`, ready for a `dv.media()` field: a
library item's reference carries its `key`, `title`, `alt`, `tags`, size and page count; a new upload's carries its
`key`, size and page count, and is selected as soon as it uploads.

It needs `createUploadUrl`, `listMediaPage` and `searchMedia` in `<DevulturProvider api>` (and `confirmUpload`, so
uploads show in the library).

```tsx
import { MediaPicker } from "@devultur/convex/react";

<MediaPicker accept={["image/*"]} value={cover} onChange={setCover} />;
<MediaPicker multiple value={attachments} onChange={setAttachments} />; // arrays in and out
```

| Prop | |
| --- | --- |
| `value` | The selection, controlled: a `DevulturMedia` or `null` (an array with `multiple`). Omitted, the picker keeps its own. |
| `onChange(value)` | Called on an upload, a pick from the library, a removal and a clear. |
| `multiple` | Several items: uploads add to the selection, and a library item toggles. Default `false`: a new pick replaces the item. |
| `accept` | File types, as `<input accept>` takes them (`image/*`, `application/pdf`, `.pdf`). Filters the files to upload and the library's items, and sets the library's type filter when every pattern is of one type. |
| `type` | Only `image`, `video` or `file` in the library; without `accept`, also what can be uploaded. |
| `labels` | Any of the picker's strings (`MediaPickerLabels`). |
| `libraryLabels`, `attachmentLabels` | The library's and the cards' strings. |
| `className` | Added to the root's `devultur-media-picker` class. |
| `children` | The layout (below). Default: the upload, the library and the selection. |

Under a `PdfPreviewProvider` with `pdfjs`, the picker reads a PDF's page count before it uploads it and records it
with the upload (`pageCount`). Without one, PDFs upload without it.

### Layout

The picker renders inline and has no dialog of its own. Its parts are `<MediaPicker.Upload>`, `<MediaPicker.Library>`
and `<MediaPicker.Selection>`; put them in any markup of yours, or pass a function as `children` to get the picker's
state (`selected`, `uploads`, `select`, `remove`, `clear`, `openFileDialog`, ...). `useMediaPicker()` returns the same
state, to build a part of your own.

```tsx
<MediaPicker multiple value={files} onChange={setFiles}>
  {(picker) => (
    <div className="grid grid-cols-[2fr_1fr] gap-4">
      <MediaPicker.Library pageSize={12} />
      <aside>
        <MediaPicker.Upload />
        <MediaPicker.Selection headingLevel={2} />
        <p>{picker.selected.length} selected</p>
      </aside>
    </div>
  )}
</MediaPicker>
```

### In a dialog, for a form field

A form keeps the reference in its state and saves it with the rest; the dialog only edits a draft of it. Here with a
native `<dialog>` (it traps focus and closes on Escape); any dialog component works the same way.

```tsx
import type { DevulturMedia } from "@devultur/core";
import { MediaPicker } from "@devultur/convex/react";
import { useMutation } from "convex/react";
import { api } from "../convex/_generated/api";

function CoverField({ value, onChange }: { value: DevulturMedia | null; onChange: (cover: DevulturMedia | null) => void }) {
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = React.useState(value);

  const handleOpen = () => {
    setDraft(value);
    dialogRef.current?.showModal();
  };
  const handleConfirm = () => {
    onChange(draft);
    dialogRef.current?.close();
  };

  return (
    <>
      <span>{value?.title ?? value?.filename ?? "No cover"}</span>
      <button type="button" onClick={handleOpen}>Choose a cover</button>
      <dialog ref={dialogRef} aria-labelledby="cover-dialog-title">
        <h2 id="cover-dialog-title">Cover</h2>
        <MediaPicker accept={["image/*"]} value={draft} onChange={setDraft} />
        <button type="button" onClick={() => dialogRef.current?.close()}>Cancel</button>
        <button type="button" onClick={handleConfirm}>Use this image</button>
      </dialog>
    </>
  );
}

function ArticleForm({ article }: { article: { _id: string; title: string; cover: DevulturMedia | null } }) {
  const save = useMutation(api.articles.update); // args: { id, title, cover: dv.media("image").optional() }
  const [title, setTitle] = React.useState(article.title);
  const [cover, setCover] = React.useState(article.cover);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    save({ id: article._id, title, cover: cover ?? undefined });
  };

  return (
    <form onSubmit={handleSubmit}>
      <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Title" />
      <CoverField value={cover} onChange={setCover} />
      <button type="submit">Save</button>
    </form>
  );
}
```

Inside a `<form>`, every button of the picker is `type="button"`, so none of them submits it.

### Accessibility

The upload button opens the file chooser; dropping files on the upload area is the pointer shortcut. Each upload
shows a labelled `<progress>`, a cancel button and, when it fails, its error in a `role="alert"` (by default a
Devultur error's message, see [Error messages](#error-messages)), with retry and dismiss. A polite live region
announces an upload's start, end and cancellation, and each selection and removal. After an upload, a removal and a
clear, focus moves to the selection's region (`<section>` named by its heading), so a keyboard user lands on the
result. The library keeps its keyboard navigation, with `aria-multiselectable` under `multiple`.

### Labels

The strings are English by default (`defaultMediaPickerLabels`). Spanish:

```tsx
import { attachmentLabels, mediaLibraryLabels, mediaPickerLabels } from "@devultur/convex/locales/es";

<MediaPicker
  labels={mediaPickerLabels}
  libraryLabels={mediaLibraryLabels}
  attachmentLabels={attachmentLabels}
  value={cover}
  onChange={setCover}
/>;
```

### Styling

The picker sets no styles but the library's layout. Each part has a class (`devultur-media-picker`,
`devultur-media-picker__upload`, `devultur-media-picker__selection`, and the library's own) and its elements have
`data-part` attributes (`upload`, `drop-hint`, `uploads`, `filename`, `percent`, `error`, `items`, `empty`,
`actions`, `replace`, `clear`); the upload area has `data-dragging` while files are dragged over it, and each upload
`data-status` (`uploading` or `failed`).

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
the same name.

`@devultur/convex/locales/es` addresses the reader with «tú» ("Vuelve a intentarlo"). For «usted» ("Vuelva a
intentarlo", "No tiene permiso…"), import the same names from `@devultur/convex/locales/es-formal`: it exports exactly
what `locales/es` does (error, attachment, preview, library, picker and video player labels), and differs only in the
strings that address the reader.

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

### Video player labels

`<VideoPlayer>` from `@devultur/react` takes `labels` like the components here do. Both Spanish locales export
`videoPlayerLabels`:

```tsx
import { VideoPlayer } from "@devultur/react";
import { videoPlayerLabels } from "@devultur/convex/locales/es";

<VideoPlayer {...useVideoProps(lesson.video)} labels={videoPlayerLabels} />;
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
The guides this README links to ship with the package, for the installed version, in
`node_modules/@devultur/convex/docs/guides/`: `video-player.md`, `self-host.md`, `plugins.md` and `object-lock.md`.

## License

[MIT](https://github.com/devultur/devultur/blob/main/LICENSE)
