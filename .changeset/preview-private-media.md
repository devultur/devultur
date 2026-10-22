---
"@devultur/convex": minor
---

Preview media inline. `useMediaObjectUrl(media, { enabled, maxBytes, contentType })` fetches a private file with the
session header into an object URL (one token re-issue on a 401 `session_mismatch`, revoked on media change and
unmount, aborted in flight); with `contentType`, public media is fetched and verified too. `<Preview media>` renders
images, PDFs, audio, text and video by content type from an allowlist (50 MiB default cap for binary previews), never
frames an unverified URL, and falls back to a `<DownloadLink>` for anything else, including HTML, SVG and XML.

`<Image>` with private media now waits for the first viewer token, and after a token re-issue fetches once (the 401
and one retry) instead of fetching again when the token changes.
