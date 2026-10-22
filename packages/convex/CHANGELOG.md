# @devultur/convex

## 1.4.1

### Patch Changes

- Updated dependencies [[`0fb3251`](https://github.com/devultur/devultur/commit/0fb3251b16689ee3558b793b7d4bb2dfb64bc051)]:
  - @devultur/core@1.4.1
  - @devultur/react@1.4.1

## 1.4.0

### Minor Changes

- [#46](https://github.com/devultur/devultur/pull/46) [`928e1ac`](https://github.com/devultur/devultur/commit/928e1ac9ef3aca7ee398fa88ca6e1f2dfbaab648) Thanks [@demarchenac](https://github.com/demarchenac)! - Document link, attachment card and responsive images.

  - `<DocumentLink media download? labels?>`: a link to a file, named by its `title` or filename. Public files link to
    their delivery URL; private files download through the session-header fetch `<DownloadLink>` uses.
  - `<AttachmentCard media onOpen? preview? labels? locale?>`: an accessible `<article>` with an icon by type, the name,
    type, size, a PDF's page count or a duration, a download link and an optional "Open preview" button that calls
    `onOpen`. Labels and formatters are English by default (`defaultAttachmentLabels`, `formatFileSize`,
    `formatDuration`); Spanish ones ship as `attachmentLabels` in `@devultur/convex/locales/es`.
  - `<Image widths sizes>` builds a `srcset` from the Worker's transforms for public images, defaults to
    `loading="lazy"` and `decoding="async"`, and fetches one width for private images (the largest up to twice the
    width `sizes` gives it). Without `widths`, `<Image>` is unchanged, and an explicit `srcSet` is passed through and
    wins over the one `widths` builds.

- [#43](https://github.com/devultur/devultur/pull/43) [`b1fbdcc`](https://github.com/devultur/devultur/commit/b1fbdcc946d302a4ae14836ba1ec21e7e056b52d) Thanks [@demarchenac](https://github.com/demarchenac)! - Guard every exposed function and localize error messages.

  - `defineDevulturFunctions(devultur, { guard, visibility?, config? })` returns the same functions as
    `Devultur.exposeApi`, and each one awaits `guard(ctx, { name, kind, args })` before it runs. The guard throws to deny
    the call and may return `{ userId }`, which `issueViewerToken` uses as the viewer token's subject.
    `visibility: "internal"` registers internal functions. Each function keeps its argument and result types.
    `devultur-init` now writes `convex/devultur.ts` with a sign-in guard that returns the user's `userId`, and exports
    `listMediaPage` and `searchMedia` (`updateMediaMeta` stays commented out: editing is library-wide, so authorize it
    in the guard first). `exposeApi` is unchanged.
  - The progress functions (`saveProgress`, `loadProgress`, `markComplete`, `resetProgress`) act only for the guard's
    `userId`: another user's `userId` in their arguments is refused with `user_mismatch` (403), unless the guard returns
    `canActForOthers: true`. Without a guard's `userId`, the browser's is kept, as `exposeApi` does.
  - The component's `issueViewerToken` takes an optional `userId` (server-side only) for the token's subject.
  - `describeDevulturError(error, labels?)` turns a component refusal, a `DevulturApiError` or a `MediaFetchError` into a
    message. `devulturErrorLabels` is the typed English map over every stable code (`DevulturErrorCode`,
    `DEVULTUR_ERROR_CODES`), and `@devultur/convex/locales/es` exports the Spanish one.

- [#47](https://github.com/devultur/devultur/pull/47) [`6e7d669`](https://github.com/devultur/devultur/commit/6e7d669898cdaea86873cf137261dd615b423e8b) Thanks [@demarchenac](https://github.com/demarchenac)! - Search and browse the media library, and pick media from it.

  - `searchMedia({ search, type?, paginationOpts })` pages through the records whose title or filename matches, on the
    `search_text` index, optionally of one type; a blank search lists newest first. In `defineDevulturFunctions`
    (guarded) and `Devultur.exposeApi`, and `devultur.searchMedia(ctx, args)` from your server.
  - `devultur.backfillSearchText(ctx, { batchSize? })` (or `npx convex run --component devultur
library:backfillSearchText`) gives records from before 1.4.0 their `searchText`, in self-scheduling batches. Any
    write to such a record also fills it.
  - `useMediaLibrary({ type?, search?, pageSize? })` from `@devultur/convex/react`: `usePaginatedQuery` over
    `listMediaPage` and `searchMedia`, with the search debounced 250 ms and pagination reset on a new query.
  - `<MediaLibrary onSelect>`: a searchable, keyboard-navigable grid (listbox, roving tab stop, arrow keys, Home, End)
    with a type filter, image thumbnails, icons, loading, empty and error states, `labels`, `selectable`,
    `renderItem`, opt-in `pdfThumbnails`, class names and `--devultur-library-*` custom properties.
  - `useDevulturApi()` returns the `api` passed to `<DevulturProvider>`, whose `DevulturApi` type gains
    `listMediaPage` and `searchMedia`.
  - `<MediaLibrary>` takes `selectedKeys` (a controlled selection), `multiple` (`aria-multiselectable`) and `filter`.
  - `<MediaPicker value? onChange accept? type? multiple? labels?>`: uploads (per-file progress, cancel, retry and
    errors through `describeDevulturError`), browses the library and shows the selection (`<AttachmentCard>` with an
    inline `<Preview>`), returning `DevulturMedia` references; a new upload is selected, and under a
    `PdfPreviewProvider` with pdf.js a PDF's `pageCount` is read before it uploads. `accept` filters the uploads and the
    library. No dialog of its own: lay out `MediaPicker.Upload`, `.Library` and `.Selection`, or pass a render prop
    (`useMediaPicker()` gives the same state). A polite live region announces uploads and selections, and focus moves
    to the selection after an upload or a removal. `defaultMediaPickerLabels` in English; `mediaPickerLabels` and
    `mediaLibraryLabels` in `@devultur/convex/locales/es`.

- [#45](https://github.com/devultur/devultur/pull/45) [`d4caa15`](https://github.com/devultur/devultur/commit/d4caa159ef2f45defc75a3f3e93f7ef4e18c225f) Thanks [@demarchenac](https://github.com/demarchenac)! - Record and edit media metadata.

  - The Worker reads an image's width and height from its header bytes on a single PUT (PNG, JPEG, GIF, WebP, AVIF),
    keeps them in the object's metadata and returns them on GET/HEAD (`x-devultur-image-width` / `-height`,
    `IMAGE_WIDTH_HEADER` / `IMAGE_HEIGHT_HEADER`). `files.head()` returns them as `width` / `height`.
  - The component's `media` records gain optional `title`, `alt`, `tags`, `pageCount` and `searchText` (title and
    filename, lowercased, behind a `search_text` search index). Records from before stay valid; no migration.
  - `confirmUpload` records the Worker's image size over the client's, and takes an optional `pageCount` (PDFs). The
    client's `width`, `height` and `pageCount` are hints: whole numbers from 1 to 100,000; another value is dropped
    (and logged) and the upload is recorded without it.
    `upload(file, { pageCount })` passes it, and `countPdfPages(file)` from `@devultur/convex/pdfjs` counts it with pdf.js.
  - `updateMediaMeta({ key, title?, alt?, tags? })`, in `defineDevulturFunctions` (guarded) and `Devultur.exposeApi`, and
    `devultur.updateMediaMeta(ctx, args)` from your server. Trimmed, tags deduplicated; title up to 200 characters, alt up
    to 1,000, up to 20 tags of 50. `invalid_media_metadata` has English and Spanish labels.
  - `DevulturMedia`, `dv.media()` and `mediaFromRecord` gain optional `title`, `alt`, `tags`, `sizeBytes`, `duration` and
    `pageCount`. `<Image>` uses `media.alt` when no `alt` is passed.

- [#49](https://github.com/devultur/devultur/pull/49) [`ccd8383`](https://github.com/devultur/devultur/commit/ccd83837e24f2eb08d5b55cfe155a7a2e4b7ffd2) Thanks [@demarchenac](https://github.com/demarchenac)! - Display-only provider and visible viewer token errors.

  - `<DevulturViewerProvider baseUrl issueViewerToken tokenArgs?>` from `@devultur/convex/react`: for apps that only show
    media. It issues and renews the viewer token like `<DevulturProvider>` and needs no upload or delete actions.
    `useDevultur().upload`, `uploadUrl` and `deleteMedia`, and the hooks that need the `api` (`useDevulturApi`,
    `useMediaUpload`, `<MediaLibrary>`, `<MediaPicker>`), throw a `DevulturCapabilityError` with the code
    `capability_unavailable`. `<DevulturProvider>` is unchanged.
  - `useDevultur()` gains `tokenStatus` (`"idle" | "loading" | "ready" | "error"`), `tokenError` and `retryToken()`. A
    viewer token action that throws or returns no token puts the status in `"error"`; it isn't retried until
    `retryToken()`.
  - While the token is in error, private media fails at once with the `MediaFetchError` code `token_unavailable`
    instead of loading: `useMediaObjectUrl`, `<Preview>` (its `fallback` receives it), `<PdfThumbnail>` (its
    `fallback`), `<Image>` (its `fallback`, and the new `onLoadError`) and `<DownloadLink>` (the new
    `onDownloadError`). They load once `retryToken()` gets a token.
  - `<VideoPlayer onError>` from `@devultur/react` reports a playlist or segment that couldn't load (a 401, or an error
    hls.js can't recover from) as a `VideoPlayerError` (`status`, `code`, `fatal`, `details`). `<Preview>`'s video
    re-issues the token once on a `session_mismatch`, then renders its `fallback` with `session_mismatch` or
    `token_unavailable`.
  - `token_unavailable` and `capability_unavailable` have English and Spanish messages in `describeDevulturError`'s
    labels, and `<Preview>`'s default labels cover `token_unavailable` and `session_mismatch`.

### Patch Changes

- Updated dependencies [[`d4caa15`](https://github.com/devultur/devultur/commit/d4caa159ef2f45defc75a3f3e93f7ef4e18c225f), [`ccd8383`](https://github.com/devultur/devultur/commit/ccd83837e24f2eb08d5b55cfe155a7a2e4b7ffd2)]:
  - @devultur/core@1.4.0
  - @devultur/react@1.4.0

## 1.3.2

### Patch Changes

- [#41](https://github.com/devultur/devultur/pull/41) [`6eb48ad`](https://github.com/devultur/devultur/commit/6eb48ad79e3ba5c5d87ac94381771eccea22a52f) Thanks [@demarchenac](https://github.com/demarchenac)! - `DevulturProvider` takes `tokenArgs`, extra arguments sent with `sessionSecret` on every viewer token issuance (first,
  renewal and re-issue). When they change by value, the provider drops the current token and issues a new one, and a
  response for the previous arguments is ignored. `issueViewerToken` lets an app pass its own token action in place of
  `api.issueViewerToken`, for example one that checks access to a workspace before issuing.
- Updated dependencies []:
  - @devultur/core@1.3.2
  - @devultur/react@1.3.2

## 1.3.1

### Patch Changes

- [#39](https://github.com/devultur/devultur/pull/39) [`7478775`](https://github.com/devultur/devultur/commit/7478775e924357a7553bbc66f6a16d6b0da530f3) Thanks [@demarchenac](https://github.com/demarchenac)! - `<Preview>`, `<PdfThumbnail>` and `PdfPreviewProvider` take `labels` (`Partial<PreviewLabels>`), so every string a
  preview shows or announces can be localized: the PDF document and page names, the loading announcement, the page-cap
  note, the default fallback's link text and per-error `title`, and the thumbnail's name. A component's `labels` win over
  the provider's, which win over `defaultPreviewLabels` (English). `<Preview>`'s `fallback` can also be a function of the
  `MediaFetchError` that caused it (`unsupported_type` when the type doesn't preview inline, `null` when no fetch was
  refused). Without `loading`, a visually hidden `role="status"` now announces `labels.loading`.
- Updated dependencies []:
  - @devultur/core@1.3.1
  - @devultur/react@1.3.1

## 1.3.0

### Minor Changes

- [#34](https://github.com/devultur/devultur/pull/34) [`54b4667`](https://github.com/devultur/devultur/commit/54b4667585ebf79e79f70e698702f9410c6c312e) Thanks [@demarchenac](https://github.com/demarchenac)! - Render PDF previews with pdf.js. Under a `PdfPreviewProvider` (with `loadPdfjs` from the new `@devultur/convex/pdfjs`
  entry, or any loader), `<Preview>` draws PDFs on `<canvas>` pages with the pdf.js legacy build: pages render lazily as
  they near the viewport, within a 5,242,880-pixel canvas cap on mobile, from the bytes of the verified fetch (pdf.js
  never gets a URL), with `enableScripting: false`, at most `maxPages` pages (default 500), and each page's text for screen readers. `pdfWorkerSrc` (or the
  provider's `workerSrc`) sets the worker. Without pdf.js, PDFs keep rendering in an `<iframe>`. New `<PdfThumbnail>`
  draws page 1 on a small canvas, fetching only once visible. `pdfjs-dist >=6.2.108` is an optional peer dependency.

- [#32](https://github.com/devultur/devultur/pull/32) [`dd5ba94`](https://github.com/devultur/devultur/commit/dd5ba94825a5aca1134f7ffd1bf3ca2fa89a7eaa) Thanks [@demarchenac](https://github.com/demarchenac)! - Preview media inline. `useMediaObjectUrl(media, { enabled, maxBytes, contentType })` fetches a private file with the
  session header into an object URL (one token re-issue on a 401 `session_mismatch`, revoked on media change and
  unmount, aborted in flight); with `contentType`, public media is fetched and verified too. `<Preview media>` renders
  images, PDFs, audio, text and video by content type from an allowlist (50 MiB default cap for binary previews), never
  frames an unverified URL, and falls back to a `<DownloadLink>` for anything else, including HTML, SVG and XML.

  `<Image>` with private media now waits for the first viewer token, and after a token re-issue fetches once (the 401
  and one retry) instead of fetching again when the token changes.

### Patch Changes

- Updated dependencies []:
  - @devultur/core@1.3.0
  - @devultur/react@1.3.0

## 1.2.0

### Patch Changes

- Updated dependencies []:
  - @devultur/core@1.2.0
  - @devultur/react@1.2.0

## 1.1.0

### Minor Changes

- [#20](https://github.com/devultur/devultur/pull/20) [`4bb7223`](https://github.com/devultur/devultur/commit/4bb722383ee58ecd123db448fc487638c46f3e21) Thanks [@demarchenac](https://github.com/demarchenac)! - Typed object lock client.

  - `createWorkerClient(...).lock` has `get`, `set`, `hold`, `release`, and `holdAll` / `releaseAll`, async iterators that follow the cursor or split a long key list into pages.
  - `createUploadUrl`, `uploadFile`, `uploads.uploadAsset` and `uploads.createToken` accept `lock` / `hold`.
  - The router refuses a lock in direct-storage mode, since a presigned PUT can't enforce one.
  - Refusals surface as `DevulturApiError` with `code` and `details`.
  - The types are re-exported from `@devultur/server`.
  - `@devultur/convex` adds `lock` / `hold` to the component's `createUploadUrl`, plus server-only component actions `lock.getLock`, `lock.setLock`, `lock.setHold` and `lock.releaseHold` (keys only).
  - The `Devultur` class gains `createUploadUrl`, `getLock`, `setLock`, `setHold` and `releaseHold`, and `exposeApi` takes a config-level `upload.lock`.

  **Behavior change in `@devultur/convex`:** when the Worker refuses a request, every component action now throws a `ConvexError` with `data: { code, message, status, details? }`. Before, it threw a plain `Error`. Apps can read `error.data.code` (for example `retention_active` or `lock_conflict`) across the component boundary, or use the new `isDevulturError` / `devulturErrorOf` helpers. Code that matched on `error.message` should switch to `data.code`.

### Patch Changes

- [#24](https://github.com/devultur/devultur/pull/24) [`7c3f197`](https://github.com/devultur/devultur/commit/7c3f197f67b8f8254b2376c7f7f8b6fac3659dc8) Thanks [@demarchenac](https://github.com/demarchenac)! - Every upload is recorded in the Convex component, and `upload()` reports its progress.
  - `listMedia` lists images and files too, not only videos: a new `confirmUpload` action (`devultur.confirmUpload(ctx, { key })`, and in `Devultur.exposeApi`) records an upload once the Worker finds its bytes, and `createUploadUrl` schedules the same check for 25 hours later, for uploads nobody confirmed. An abandoned upload is never recorded. Filter with `listMedia({ type: "image" | "video" | "file" })`; `devultur.listMedia(ctx)` and `mediaFromRecord(record)` turn rows into `DevulturMedia` references.
  - `listMediaPage({ type?, paginationOpts })` pages the library newest first on a new `by_type` index (`devultur.listMediaPage(ctx, ...)`, and in `Devultur.exposeApi`). `listMedia` is unchanged and unbounded.
  - Media records gain optional `visibility`, `objectKey`, `width` and `height` fields. Existing records stay valid: nothing to migrate.
  - `deleteMedia` drops an image's or a file's record once the Worker deleted the object. `createMedia` is idempotent per key.
  - `useDevultur().upload(file, { onProgress, signal })` reports `{ loadedBytes, totalBytes, fraction }` of the PUT (XHR, in parts for large files), can be aborted, confirms the upload when the provider's `api` has `confirmUpload`, and resolves to a `DevulturMedia` carrying the uploaded `key`. `useMediaUpload` confirms too and sets `key` as well.
  - `DevulturMedia` and `dv.media()` gain an optional `key` (the uploaded object's key). References stored without it stay valid; delivery paths never read it.
  - `uploadFileWithProgress` from `@devultur/react` takes `onBytes` for the same byte progress.
- Updated dependencies [[`7c3f197`](https://github.com/devultur/devultur/commit/7c3f197f67b8f8254b2376c7f7f8b6fac3659dc8), [`4bb7223`](https://github.com/devultur/devultur/commit/4bb722383ee58ecd123db448fc487638c46f3e21), [`240b366`](https://github.com/devultur/devultur/commit/240b366d7b5134bca0927d7b7a4d885ad088d879), [`def83a3`](https://github.com/devultur/devultur/commit/def83a364ad03b1397805d6488af33bbf7a93252), [`54796f4`](https://github.com/devultur/devultur/commit/54796f4bf7f18ee7d510928552c7357649523f32)]:
  - @devultur/core@1.1.0
  - @devultur/react@1.1.0

## 1.0.3

### Patch Changes

- [#12](https://github.com/devultur/devultur/pull/12) [`1f6cc5a`](https://github.com/devultur/devultur/commit/1f6cc5a6982aed728b1e8c1b1d8299e7bf7e6252) Thanks [@demarchenac](https://github.com/demarchenac)! - Fix three gaps in the Convex component, and the same captioning bug in core:

  - Regenerate the component's `_generated` code: `ComponentApi` now matches the component's functions
    (`createUploadUrl` and `deleteVideo` take `visibility`, `updateMedia` takes `failureReason`, `retriable` and the
    `queued` status). A test now fails when `_generated` drifts from the source; `pnpm --filter @devultur/convex codegen`
    regenerates it.
  - A video transcoded without captions no longer stays in `captioning`: `transcode.complete` goes straight to `ready`
    unless requested captions are still pending (tracked in the new `captionsPending` field). A failed captions request
    stops the wait too.
  - Document that the app must mount the component with an `httpPrefix` (`app.use(devultur, { httpPrefix: "/devultur/" })`)
    for Convex to serve its webhook route at `https://<deployment>.convex.site/devultur/webhook`; `devultur-init` warns
    when an existing mount lacks it.
  - `handleWebhook` in `@devultur/core` follows the same rule: `transcode.complete` goes to `ready` unless the record has
    `captionsPending: true` (set it when you request captions), and `captions.complete` clears it.

- Updated dependencies [[`1f6cc5a`](https://github.com/devultur/devultur/commit/1f6cc5a6982aed728b1e8c1b1d8299e7bf7e6252)]:
  - @devultur/core@1.0.3
  - @devultur/react@1.0.3

## 1.0.2

### Patch Changes

- [#9](https://github.com/devultur/devultur/pull/9) [`a73c6eb`](https://github.com/devultur/devultur/commit/a73c6ebff7ba73843931901b99236f409f2eb767) Thanks [@demarchenac](https://github.com/demarchenac)! - `devultur-init` now generates a `convex.config.ts` whose `defineApp()` declares `DEVULTUR_SECRET` and `DEVULTUR_API_URL`. Before, the generated config bound `app.env.DEVULTUR_SECRET` without declaring it, and Convex rejected it. When it patches an existing config that doesn't declare them, it prints the `env` to add.

- Updated dependencies []:
  - @devultur/core@1.0.2
  - @devultur/react@1.0.2

## 1.0.1

### Patch Changes

- [#1](https://github.com/devultur/devultur/pull/1) [`7c049c2`](https://github.com/devultur/devultur/commit/7c049c2b7613c2f7b01b92692e43c1150e025d11) Thanks [@demarchenac](https://github.com/demarchenac)! - Add a package description and keywords so the packages show up in npm search with a summary

- Updated dependencies [[`7c049c2`](https://github.com/devultur/devultur/commit/7c049c2b7613c2f7b01b92692e43c1150e025d11)]:
  - @devultur/core@1.0.1
  - @devultur/react@1.0.1
