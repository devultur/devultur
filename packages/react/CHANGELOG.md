# @devultur/react

## 1.5.0

### Minor Changes

- [#56](https://github.com/devultur/devultur/pull/56) [`7a67982`](https://github.com/devultur/devultur/commit/7a6798291c5ce666782c7543f1d7b0f40a287128) Thanks [@demarchenac](https://github.com/demarchenac)! - - `<DevulturViewerProvider>` takes no `issueViewerToken` when every media is public: it then needs no Convex client and issues nothing. With an action it still issues the token as soon as it mounts; `lazyToken` issues it only once a private media is shown, and `useDevultur().requestToken()` asks for it from code that reads `token` itself.
  - `config.upload.visibility` sets the visibility of an upload whose caller passes none. A guard can return `rewrite: { name, args }` to rewrite the caller's arguments on the server, typed for the named operation; it wins over the browser's arguments, which win over the config's default.
  - `<VideoPlayer labels>` replaces any of the player's strings (`VideoPlayerLabels`, `defaultVideoPlayerLabels`), and so does the `labels` prop of each control. `@devultur/convex/locales/es` and `locales/es-formal` export `videoPlayerLabels`.
  - `<Preview metrics>` passes `metrics` to a video's player, and a private video shows `loading` until its viewer token is issued instead of a refused first request.
  - `useDevulturOptional()` returns the provider's value, or `null` outside a provider instead of throwing.
  - The docs describe the player's playback metrics: on by default, anonymous, no cookies, what each beacon carries and where it goes, and `metrics={false}` to turn them off.

### Patch Changes

- Updated dependencies []:
  - @devultur/core@1.5.0

## 1.4.3

### Patch Changes

- [#54](https://github.com/devultur/devultur/pull/54) [`7113e9a`](https://github.com/devultur/devultur/commit/7113e9a19bd4e73523678d0f2d473382f3b0a0dd) Thanks [@demarchenac](https://github.com/demarchenac)! - Tree-shakeable entry, aligned types and self-contained source maps.

  - `@devultur/convex` and `@devultur/react` declare `"sideEffects": false`, and `MediaPicker` is built in one pure expression, so an app that imports only `<Image>` from `@devultur/convex/react` no longer bundles the picker, the library, `usePaginatedQuery` or the video player.
  - `DevulturViewerProvider` and `DevulturProvider` accept the `issueViewerToken` that `defineDevulturFunctions` and `exposeApi` generate (its `sessionSecret` is optional).
  - The `Devultur` methods take any ctx with the runner they call, and the guard's ctx is of any data model, so an app's `GenericActionCtx<DataModel>` (and its query and mutation ctx) no longer fails with TS2345.
  - `MediaRecord` is inferred from the component's schema, so it now has `failureReason`, `retriable`, `posterUrls`, `renditions`, `hasAudio` and `transcodeProgress.phase`.
  - The component's source maps embed their sources, so test runners no longer warn about missing files.

- Updated dependencies []:
  - @devultur/core@1.4.3

## 1.4.2

### Patch Changes

- Updated dependencies []:
  - @devultur/core@1.4.2

## 1.4.1

### Patch Changes

- Updated dependencies [[`0fb3251`](https://github.com/devultur/devultur/commit/0fb3251b16689ee3558b793b7d4bb2dfb64bc051)]:
  - @devultur/core@1.4.1

## 1.4.0

### Minor Changes

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

- Updated dependencies [[`d4caa15`](https://github.com/devultur/devultur/commit/d4caa159ef2f45defc75a3f3e93f7ef4e18c225f)]:
  - @devultur/core@1.4.0

## 1.3.2

### Patch Changes

- Updated dependencies []:
  - @devultur/core@1.3.2

## 1.3.1

### Patch Changes

- Updated dependencies []:
  - @devultur/core@1.3.1

## 1.3.0

### Patch Changes

- Updated dependencies []:
  - @devultur/core@1.3.0

## 1.2.0

### Patch Changes

- Updated dependencies []:
  - @devultur/core@1.2.0

## 1.1.0

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

## 1.0.3

### Patch Changes

- Updated dependencies [[`1f6cc5a`](https://github.com/devultur/devultur/commit/1f6cc5a6982aed728b1e8c1b1d8299e7bf7e6252)]:
  - @devultur/core@1.0.3

## 1.0.2

### Patch Changes

- Updated dependencies []:
  - @devultur/core@1.0.2

## 1.0.1

### Patch Changes

- [#1](https://github.com/devultur/devultur/pull/1) [`7c049c2`](https://github.com/devultur/devultur/commit/7c049c2b7613c2f7b01b92692e43c1150e025d11) Thanks [@demarchenac](https://github.com/demarchenac)! - Add a package description and keywords so the packages show up in npm search with a summary

- Updated dependencies [[`7c049c2`](https://github.com/devultur/devultur/commit/7c049c2b7613c2f7b01b92692e43c1150e025d11)]:
  - @devultur/core@1.0.1
