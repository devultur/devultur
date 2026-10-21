# Upgrading to 1.1 and 1.2

What changes when you move the packages to 1.1 or 1.2, and what to do after upgrading.

Upgrade every `@devultur/*` package to the same version. 1.2 only adds functions (`deletePrefixRespectingLocks`,
`readObjectLock` and `retainedSummary` in `@devultur/self-host`, see
[Deleting a prefix from your own code](object-lock.md#deleting-a-prefix-from-your-own-code)), so the steps below are
the ones for 1.1.

## The media Worker

- **Encryption fails closed.** With `security.encrypt` on and no `KEYS_BUCKET` bound, the Worker used to store
  private files in plaintext. It now refuses with `503 keys_bucket_missing` and stores nothing. Bind a `KEYS_BUCKET`
  (see the [self-host guide](self-host.md)) or turn `encrypt` off. Files a misconfigured Worker already stored in
  plaintext stay plaintext, and so do their image variants: re-upload them, with `KEYS_BUCKET` bound, to encrypt them.
- **Purge the edge cache after deploying.** Edge copies stored before 1.1 lack the expiry cap and can be served for
  up to 7 days.
- **Transcode outputs written before 1.1 carry no `expiresAt`**, so they stay readable after their video's raw file
  expires. Re-transcode or delete those videos to bring them in line.
- **Retention and holds** are new: locks at upload, `GET`/`PUT /v1/lock/<key>`, `POST /v1/lock/hold`, the
  `authorizeLockChange` and `onLockAudit` plugin hooks, and `409 retention_active` on deletes and overwrites of a
  locked file. Nothing is locked unless you ask for it. See [Retention and holds](object-lock.md).
- **Keys under `__lock/` and `__lock-audit/` are reserved.** If you stored objects there, move them first.

## `@devultur/convex`

### Errors are `ConvexError`s

When the Worker refuses a request, every component action now throws a `ConvexError` whose `data` is
`{ code, message, status, details? }`. Before, it threw a plain `Error`. Code that matched on `error.message` should
read `data.code` instead, or use `devulturErrorOf(error)` / `isDevulturError(error)`. See
[Errors](../../packages/convex/README.md#errors).

### Every upload is recorded

`listMedia` now lists images and files too, not only videos:

1. Export `confirmUpload` from `convex/devultur.ts`, next to the other functions of `Devultur.exposeApi`.
   `devultur-init` adds it to new apps but skips an existing `convex/devultur.ts`. `useDevultur().upload()` and
   `useMediaUpload` call it after the PUT when the `api` you pass `<DevulturProvider>` has it. Like the other exposed
   functions, it has no auth of its own: wrap it with your app's.
2. Without it, `createUploadUrl` still schedules the same check 25 hours later, so records arrive late.

If your code assumed `listMedia` only returned videos, filter it with `listMedia({ type: "video" })`. Page a large
library with `listMediaPage({ type?, paginationOpts })`. Records from before 1.1 stay valid: the new fields are
optional and there's nothing to migrate. See [Media library](../../packages/convex/README.md#media-library).

### Upload progress and the uploaded key

`upload(file, { onProgress, signal })` reports the PUT's progress, can be aborted, and resolves to a `DevulturMedia`
that carries the uploaded object's `key`. `key` is an optional field of `DevulturMedia` and `dv.media()`, so
references stored without it stay valid. See [Upload progress](../../packages/convex/README.md#upload-progress).

## `@devultur/core` and `@devultur/server`

`DevulturApiError` gains `details`, with the rest of the Worker's answer (such as the `key`, `mode`, `until` and
`hold` of a `409 retention_active`). `createWorkerClient(...).lock` and the `lock` / `hold` options of
`createUploadUrl`, `uploadFile` and the upload tokens are new. A lock in direct-storage mode (no Worker) is refused,
since a presigned PUT can't enforce one.
