---
"@devultur/convex": patch
"@devultur/react": patch
---

Tree-shakeable entry, aligned types and self-contained source maps.

- `@devultur/convex` and `@devultur/react` declare `"sideEffects": false`, and `MediaPicker` is built in one pure expression, so an app that imports only `<Image>` from `@devultur/convex/react` no longer bundles the picker, the library, `usePaginatedQuery` or the video player.
- `DevulturViewerProvider` and `DevulturProvider` accept the `issueViewerToken` that `defineDevulturFunctions` and `exposeApi` generate (its `sessionSecret` is optional).
- The `Devultur` methods take any ctx with the runner they call, and the guard's ctx is of any data model, so an app's `GenericActionCtx<DataModel>` (and its query and mutation ctx) no longer fails with TS2345.
- `MediaRecord` is inferred from the component's schema, so it now has `failureReason`, `retriable`, `posterUrls`, `renditions`, `hasAudio` and `transcodeProgress.phase`.
- The component's source maps embed their sources, so test runners no longer warn about missing files.
