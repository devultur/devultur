# @devultur/self-host

## 1.2.0

### Minor Changes

- [#27](https://github.com/devultur/devultur/pull/27) [`6eb3aa4`](https://github.com/devultur/devultur/commit/6eb3aa461d0c18cfc5f71fb0fd23663df23082df) Thanks [@demarchenac](https://github.com/demarchenac)! - Code that runs in your Worker (a plugin route, a scheduled sweeper) can now delete whole prefixes from the R2 binding without destroying retained files.

  - `deletePrefixRespectingLocks({ mediaBucket, keysBucket?, prefix, root?, cursor?, batchSize?, maxSubrequests? })` deletes what's free under a storage prefix the way `DELETE /v1/media/:key` does (with its encryption keys and its variants'; an emptied video folder also loses its HLS key and transcode-completed marker, sparing keys of uploads in flight) and keeps what's locked, with its keys, variants and lock records. It returns `{ deletedCount, deletedBytes, deletedKeyCount, retainedCount, retainedBytes, retained, skippedCount, cursor?, subrequests }`. It never makes more than `maxSubrequests` bucket calls (default 40, under the Workers Free plan's 50 subrequests per request; raise it on a paid plan), never stops halfway through an object, and returns a `cursor` to resume from.
  - It takes no `now`: locks are judged by the real clock, so no option can make a retention read as expired. A cursor works only with the prefix it was returned for; a malformed or out-of-bounds one throws `RangeError` before any bucket call.
  - Lock records and audit objects are never touched, and a key not laid out like the Worker's (no `public`/`private` segment where expected) is kept and reported with `unrecognized: true`.
  - `readObjectLock({ mediaBucket, root?, now? }, storageKey)` returns the lock in force on one stored object (`{ locked, hold, until?, mode?, unreadable?, unrecognized?, lockedBy? }`), resolved like the routes do: the upload lock or the version-bound lock record, unreadable records held, a video's files inheriting from its raws and an image's variants from it (both free under `original-only`).
  - `retainedSummary({ mediaBucket, prefix, cursor?, now? })` answers "can this be deleted?" without deleting: `{ scannedCount, retainedCount, retainedBytes, latestUntil?, hasHold, cursor?, subrequests }`, bounded the same way.

  Keys are full storage keys; the storage prefix each lives under is read from the key, or passed as `root`. See "Deleting a prefix from your own code" in the object lock guide.

### Patch Changes

- Updated dependencies []:
  - @devultur/core@1.2.0

## 1.1.0

### Minor Changes

- [#18](https://github.com/devultur/devultur/pull/18) [`498165c`](https://github.com/devultur/devultur/commit/498165c9addd86e27d9c77dfb51fb1895bc1c15c) Thanks [@demarchenac](https://github.com/demarchenac)! - Change locks after upload, and audit every lock event.

  - `GET /v1/lock/:key` reads an object's lock. `PUT /v1/lock/:key` sets or extends it (`mode`, `until`, `period`, `derivatives`). These are bearer-only control routes.
  - Compliance only extends. A governance retention can be shortened or removed (`remove: true`) only with `bypassGovernance` and the approval of an `authorizeLockChange` plugin hook. Otherwise the answer is `403 lock_privilege_required`.
  - Changes go to a compare-and-swap sidecar under `__lock/` (a concurrent change gets `409 lock_conflict`). The sidecar is bound to the object version it was written for.
  - Every change, rejected delete or overwrite, and retained original is audited: a structured log line, a create-only record under `__lock-audit/{yyyy-mm-dd}/`, and the `onLockAudit` hook.
  - Owner reads carry `x-devultur-lock-until` and `x-devultur-lock-hold`.
  - A completed transcode is now recorded durably. A locked video can be re-transcoded until a transcode completes, and not after.

- [#16](https://github.com/devultur/devultur/pull/16) [`1722bb7`](https://github.com/devultur/devultur/commit/1722bb760745578d6676e8abe72ca98b1c898dae) Thanks [@demarchenac](https://github.com/demarchenac)! - Lock files at upload and refuse to delete them while locked. An upload takes `lock` (`retention` and `hold`) or `hold` from the request, from the upload token (`lock` on `POST /v1/token/upload`, a minimum the request can't loosen) or from `config.lock`, and stores it on the object in the same write. `DELETE /v1/media/:key` and `DELETE /v1/media/videos/:videoId` answer `409 retention_active` with `{ key, mode, until, hold }` while the file, or for a video's derived files its original (`retention.derivatives: "inherit"`), is locked; deleting the encryption keys is refused the same way. A locked original is kept after a transcode even with `deleteOriginalOnSuccess`. Keys under `__lock/` and `__lock-audit/` are reserved.

- [#19](https://github.com/devultur/devultur/pull/19) [`d558f92`](https://github.com/devultur/devultur/commit/d558f9263273891b292e0c02835b18151089413d) Thanks [@demarchenac](https://github.com/demarchenac)! - Set and release holds. `POST /v1/lock/hold` takes `{ hold, keys }` (up to 50 keys) or `{ hold, prefix, cursor? }` (50 objects per page) and answers `{ updated, skipped, cursor? }`. It is the one way to change a hold, including for a single object. A hold never touches the retention. Releasing it starts a `period` at release time; without a retention, the object is free again. Each page goes through `authorizeLockChange` (`hold` or `release`), and every object changed is audited. An upload that carries a lock now gets its first audit record (`set`, with the uploader as actor).

- [#17](https://github.com/devultur/devultur/pull/17) [`125a5bf`](https://github.com/devultur/devultur/commit/125a5bf08c0d201f6f3e0799fe6b101756c9ee39) Thanks [@demarchenac](https://github.com/demarchenac)! - Refuse to overwrite locked files. The upload PUT, multipart create and complete, captions and re-transcodes answer `409 retention_active` when they would replace a locked file or a retained output of a locked video. New outputs and new caption locales are still allowed, and so is the first transcode of a locked video. `POST /v1/upload` with `overwrite: true` refuses a locked asset before any bytes are sent. Every upload write is conditional on the object the check saw. If it changed in between, the upload answers `409 write_conflict` and removes the encryption key it created, and the client retries.

  While a transcode job is in progress (status `queued` or `running`), the runner's credential can still rewrite that job's own outputs, so an upload retry doesn't fail on a locked video. From `transcode.complete` on, those outputs are protected like any other derived file.

  A first transcode of a locked video that failed can be retried, and the new job may overwrite the partial outputs. Only a transcode that completed blocks re-transcoding.

### Patch Changes

- [#23](https://github.com/devultur/devultur/pull/23) [`f12c61b`](https://github.com/devultur/devultur/commit/f12c61bdcd5ead664a88641843c18056421c8293) Thanks [@demarchenac](https://github.com/demarchenac)! - Encryption at rest fails closed. With `security.encrypt` on (Worker-wide or per resource) and no `KEYS_BUCKET` bound, the Worker used to store private files in plaintext without a word. It now refuses with `503 keys_bucket_missing` and stores nothing:

  - `POST /v1/upload` refuses before the client uploads any bytes, and the upload `PUT` and multipart create refuse as a backstop.
  - `POST /v1/transcode` refuses to launch a private video, whose HLS segments couldn't be encrypted.
  - `POST /v1/captions` refuses before transcribing a private video.

  **Behaviour change for misconfigured Workers:** a Worker with `encrypt` on and no `KEYS_BUCKET` now answers `503` to those requests instead of storing plaintext. Bind a `KEYS_BUCKET` (see the self-host guide) or turn `encrypt` off. Public files, HLS segments and Workers with encryption off are unaffected. The code is exported as `KEYS_BUCKET_MISSING_CODE`.

  **Upgrading:** nothing already stored is encrypted after the fact. Private files that a Worker with `encrypt` on and no `KEYS_BUCKET` stored in plaintext stay plaintext, and so do their image variants. Re-upload them, with `KEYS_BUCKET` bound, to encrypt them.

- [#26](https://github.com/devultur/devultur/pull/26) [`a83507e`](https://github.com/devultur/devultur/commit/a83507e580fc30ccb81fc49ffa9b660fb8bbc312) Thanks [@demarchenac](https://github.com/demarchenac)! - A delete no longer destroys the encryption key of an upload still writing the same key.

  - `DELETE /v1/media/:key` sweeps only the deleted version's key and the keys written before it. A key written after it belongs to an upload in flight (a multipart overwrite created before the delete, or a PUT between its key and its write), which now completes into an object that decrypts.
  - The upload PUT and the multipart complete check that their key still exists right before writing the object. If it's gone, they answer `500 encryption_key_missing` (exported as `ENCRYPTION_KEY_MISSING_CODE`) and store nothing; the multipart session is aborted, so the client uploads again.
  - A retried or concurrent multipart complete no longer deletes the key of the object the first complete wrote.

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
