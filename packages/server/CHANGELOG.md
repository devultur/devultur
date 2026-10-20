# @devultur/server

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
