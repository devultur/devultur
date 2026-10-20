---
"@devultur/core": minor
"@devultur/server": minor
"@devultur/convex": minor
---

Typed object lock client.
- `createWorkerClient(...).lock` has `get`, `set`, `hold`, `release`, and `holdAll` / `releaseAll`, async iterators that follow the cursor or split a long key list into pages.
- `createUploadUrl`, `uploadFile`, `uploads.uploadAsset` and `uploads.createToken` accept `lock` / `hold`.
- The router refuses a lock in direct-storage mode, since a presigned PUT can't enforce one.
- Refusals surface as `DevulturApiError` with `code` and `details`.
- The types are re-exported from `@devultur/server`.
- `@devultur/convex` adds `lock` / `hold` to the component's `createUploadUrl`, plus server-only component actions `lock.getLock`, `lock.setLock`, `lock.setHold` and `lock.releaseHold` (keys only).
- The `Devultur` class gains `createUploadUrl`, `getLock`, `setLock`, `setHold` and `releaseHold`, and `exposeApi` takes a config-level `upload.lock`.

**Behavior change in `@devultur/convex`:** when the Worker refuses a request, every component action now throws a `ConvexError` with `data: { code, message, status, details? }`. Before, it threw a plain `Error`. Apps can read `error.data.code` (for example `retention_active` or `lock_conflict`) across the component boundary, or use the new `isDevulturError` / `devulturErrorOf` helpers. Code that matched on `error.message` should switch to `data.code`.
