---
"@devultur/convex": minor
"@devultur/react": minor
---

Display-only provider and visible viewer token errors.

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
