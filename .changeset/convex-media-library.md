---
"@devultur/core": patch
"@devultur/convex": patch
"@devultur/react": patch
---

Every upload is recorded in the Convex component, and `upload()` reports its progress.
- `listMedia` lists images and files too, not only videos: a new `confirmUpload` action (`devultur.confirmUpload(ctx, { key })`, and in `Devultur.exposeApi`) records an upload once the Worker finds its bytes, and `createUploadUrl` schedules the same check for 25 hours later, for uploads nobody confirmed. An abandoned upload is never recorded. Filter with `listMedia({ type: "image" | "video" | "file" })`; `devultur.listMedia(ctx)` and `mediaFromRecord(record)` turn rows into `DevulturMedia` references.
- `listMediaPage({ type?, paginationOpts })` pages the library newest first on a new `by_type` index (`devultur.listMediaPage(ctx, ...)`, and in `Devultur.exposeApi`). `listMedia` is unchanged and unbounded.
- Media records gain optional `visibility`, `objectKey`, `width` and `height` fields. Existing records stay valid: nothing to migrate.
- `deleteMedia` drops an image's or a file's record once the Worker deleted the object. `createMedia` is idempotent per key.
- `useDevultur().upload(file, { onProgress, signal })` reports `{ loadedBytes, totalBytes, fraction }` of the PUT (XHR, in parts for large files), can be aborted, confirms the upload when the provider's `api` has `confirmUpload`, and resolves to a `DevulturMedia` carrying the uploaded `key`. `useMediaUpload` confirms too and sets `key` as well.
- `DevulturMedia` and `dv.media()` gain an optional `key` (the uploaded object's key). References stored without it stay valid; delivery paths never read it.
- `uploadFileWithProgress` from `@devultur/react` takes `onBytes` for the same byte progress.
