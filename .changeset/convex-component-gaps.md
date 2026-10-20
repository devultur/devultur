---
"@devultur/convex": patch
---

Fix three gaps in the Convex component:

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
