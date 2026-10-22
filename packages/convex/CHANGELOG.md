# @devultur/convex

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
