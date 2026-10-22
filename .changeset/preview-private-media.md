---
"@devultur/convex": minor
---

Preview private media inline. `useMediaObjectUrl(media, { enabled, maxBytes, contentType })` fetches a private file
with the session header into an object URL (one token re-issue on a 401 `session_mismatch`, revoked on media change
and unmount, aborted in flight). `<Preview media>` renders images, PDFs, audio, text and video by content type from an
allowlist, and falls back to a `<DownloadLink>` for anything else, including HTML, SVG and XML.
