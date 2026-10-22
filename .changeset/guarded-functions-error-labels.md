---
"@devultur/convex": minor
---

Guard every exposed function and localize error messages.

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
