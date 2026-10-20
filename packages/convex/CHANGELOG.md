# @devultur/convex

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
