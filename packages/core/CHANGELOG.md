# @devultur/core

## 1.3.2

## 1.3.1

## 1.3.0

### Minor Changes

- [#35](https://github.com/devultur/devultur/pull/35) [`beea095`](https://github.com/devultur/devultur/commit/beea095) Thanks [@demarchenac](https://github.com/demarchenac)! - Uploads are checked against their declared Content-Type. The Worker reads the first 4 KB of the plaintext and compares
  them with a signature table (PDF, PNG, JPEG, GIF, WebP, AVIF, HEIF, MP4/MOV/M4A, WebM/Matroska, MP3, Ogg, WAV, FLAC,
  zip-based documents, plain text, CSV and JSON). Types outside the table keep their declared type, and a transcode's
  outputs, written with the runner's own types, are never checked.

  **The default (`contentSniffing: "scriptable"`) only rejects markup:** a "PDF", image or text upload that is really
  HTML, SVG or XML answers `415 content_type_mismatch` (with `declared` and `detected`) and stores nothing. Any other
  mismatch is stored with its declared type, as before. Every mismatch is logged as
  `[content-sniff] {declared, detected, key, action}`. You can opt into `"reject"` (415 for every mismatch),
  `"octet-stream"` (a mismatching single PUT is stored as `application/octet-stream`) or `"off"` with
  `defaultPlugins({ contentSniffing })`. The security guide lists the real files the stricter modes turn away.

  For a multipart upload, every upload of part 1 is checked: a rejected one aborts the upload and deletes its pending
  upload and encryption key. `complete` answers `409 content_unverified` unless it names the part 1 that was checked.
  `uploadMultipart` (`@devultur/core`) makes up to 3 attempts at a complete that gets `content_unverified`, with a
  growing delay.

  Delivery also adds `Cross-Origin-Resource-Policy: cross-origin` to public media, and the sandbox policy for risky types
  is now `Content-Security-Policy: sandbox; default-src 'none'`.

## 1.2.0

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

- [#14](https://github.com/devultur/devultur/pull/14) [`240b366`](https://github.com/devultur/devultur/commit/240b366d7b5134bca0927d7b7a4d885ad088d879) Thanks [@demarchenac](https://github.com/demarchenac)! - Add object lock types and rules: `Retention` (`governance` or `compliance`, a fixed `until` or a `period`, and `derivatives`) and `hold`, resolved with `resolveLock` (resource override, then app default, then off) and validated with `validateLock`. Pure helpers `effectiveUntil`, `isLocked` and `canChange` implement the expiry and change rules. `DevulturApiError` gains `details` with the response body's extra fields, such as the `key`, `mode`, `until` and `hold` of a `409 retention_active`. The Worker doesn't enforce locks yet.

### Patch Changes

- [#24](https://github.com/devultur/devultur/pull/24) [`7c3f197`](https://github.com/devultur/devultur/commit/7c3f197f67b8f8254b2376c7f7f8b6fac3659dc8) Thanks [@demarchenac](https://github.com/demarchenac)! - Every upload is recorded in the Convex component, and `upload()` reports its progress.

  - `listMedia` lists images and files too, not only videos: a new `confirmUpload` action (`devultur.confirmUpload(ctx, { key })`, and in `Devultur.exposeApi`) records an upload once the Worker finds its bytes, and `createUploadUrl` schedules the same check for 25 hours later, for uploads nobody confirmed. An abandoned upload is never recorded. Filter with `listMedia({ type: "image" | "video" | "file" })`; `devultur.listMedia(ctx)` and `mediaFromRecord(record)` turn rows into `DevulturMedia` references.
  - `listMediaPage({ type?, paginationOpts })` pages the library newest first on a new `by_type` index (`devultur.listMediaPage(ctx, ...)`, and in `Devultur.exposeApi`). `listMedia` is unchanged and unbounded.
  - Media records gain optional `visibility`, `objectKey`, `width` and `height` fields. Existing records stay valid: nothing to migrate.
  - `deleteMedia` drops an image's or a file's record once the Worker deleted the object. `createMedia` is idempotent per key.
  - `useDevultur().upload(file, { onProgress, signal })` reports `{ loadedBytes, totalBytes, fraction }` of the PUT (XHR, in parts for large files), can be aborted, confirms the upload when the provider's `api` has `confirmUpload`, and resolves to a `DevulturMedia` carrying the uploaded `key`. `useMediaUpload` confirms too and sets `key` as well.
  - `DevulturMedia` and `dv.media()` gain an optional `key` (the uploaded object's key). References stored without it stay valid; delivery paths never read it.
  - `uploadFileWithProgress` from `@devultur/react` takes `onBytes` for the same byte progress.

- [#25](https://github.com/devultur/devultur/pull/25) [`def83a3`](https://github.com/devultur/devultur/commit/def83a364ad03b1397805d6488af33bbf7a93252) Thanks [@demarchenac](https://github.com/demarchenac)! - Object lock fixes from a second security review:

  - **Edge cache:** an owner read (Worker secret) never reads or stores a public edge copy, and gets the private form of the file's `Cache-Control`, so an expired file and the `x-devultur-lock-*` headers never reach a shared cache. A copy's TTL is capped at the file's `expiresAt`, and a copy found past it is ignored (`410`).
  - **Lock records outlive deletes:** deleting or overwriting a file leaves its lock record in place, inert (it's bound to the replaced version). A hold or retention set on the new file right after the write is no longer lost.
  - **Bounded listings:** `GET /v1/assets` reads at most 32 lock records (`MAX_EXPIRED_LOOKUPS`) per page for expired entries. Past that, the page ends early with a cursor that resumes after its last entry.
  - **Derived files expire:** transcode outputs (HLS, MP4, thumbnails, poster, storyboard) inherit the earliest `expiresAt` of the video's raws, and captions the one of their source, so they answer `410` with it.
  - **Encryption keys of replaced versions:** an overwrite deletes the replaced version's key, and a delete sweeps the keys the object's versions left behind (never an asset nested under its path, nor an upload in flight).
  - **Unreadable lock records:** a lock record (or upload `lock` metadata) that can't be read stays held. A release is skipped with `lock_record_unreadable` (new `HoldSkip` reason in `@devultur/core`), and `PUT /v1/lock/<key>` answers `409 lock_record_unreadable`.
  - **Docs:** the expiry cleanup is the operator's to run (none ships), listings expose retention to whoever can list, and how to repair an unreadable lock record.

  **Upgrading:**

  - Purge the edge cache after deploying. Edge copies stored before 1.1.0 lack the expiry cap and can be served for up to 7 days.
  - Transcode outputs written before 1.1.0 carry no `expiresAt`, so they stay readable after their video's raw expires. Re-transcode or delete those videos to bring them in line.

- [#22](https://github.com/devultur/devultur/pull/22) [`54796f4`](https://github.com/devultur/devultur/commit/54796f4bf7f18ee7d510928552c7357649523f32) Thanks [@demarchenac](https://github.com/demarchenac)! - Object lock fixes from a security review:
  - **Nested assets:** deleting an asset no longer deletes the encryption keys of assets nested under its path.
  - **Stale lock records:** a lock record is bound to R2's per-write `version`, never the etag (the content's MD5, which repeats). A stale record can't free a re-uploaded file with identical bytes.
  - **Held periods:** while a hold is set, a retention `period` can't be swapped for an `until`. Compliance refuses it, and governance needs the privilege.
  - **Period bound:** a `period` is capped at 100 years, and an expiry that can't be computed is refused rather than failing with a 500.
  - **Bulk holds:** a hold by prefix skips the Worker's own `__lock/` and `__lock-audit/` records.
  - **Hook refusals:** a hold refused by `authorizeLockChange` is audited.
  - **Completion marker:** the durable transcode completion marker is written from the job's signed ticket, so it no longer depends on the 24 h launch record.
  - **Invalid release times:** a lock record with an invalid hold release time fails closed.
  - **Authenticated PUTs:** an authenticated `PUT /v1/upload/<key>` with no pending upload gets `config.lock` (originals only).
  - **Retention vs expiry:** these are now separate, as in S3 Object Lock. Retention preserves a file; it doesn't extend access to it.
    - Past `expiresAt`, viewers, public requests and download links get `410`, even for a retained file.
    - The owner (Worker secret) can still read a retained file, which isn't deleted until its lock ends.
    - `GET /v1/assets` lists expired-but-retained files with `expired: true` and `retainedUntil` or `hold: true` (new optional `AssetEntry` fields in `@devultur/core`).
    - A lock may now outlive `expiresAt`: the `400 lock_conflicts_expiry` refusal is gone.
  - **Conditional writes:** writes over an existing object are also pinned by its upload time, not only its etag.

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

## 1.0.2

## 1.0.1

### Patch Changes

- [#1](https://github.com/devultur/devultur/pull/1) [`7c049c2`](https://github.com/devultur/devultur/commit/7c049c2b7613c2f7b01b92692e43c1150e025d11) Thanks [@demarchenac](https://github.com/demarchenac)! - Add a package description and keywords so the packages show up in npm search with a summary
