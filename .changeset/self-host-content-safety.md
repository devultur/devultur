---
"@devultur/self-host": minor
---

**Behaviour change:** media delivery (`GET /v1/media/*`) and download-link responses now carry
`X-Content-Type-Options: nosniff`. A file whose type is outside the safe-inline list (images except SVG, `video/*`,
`audio/*`, PDF, plain text, CSV, JSON, VTT, HLS playlists) is also served with `Content-Security-Policy: sandbox` and
`Content-Disposition: attachment`, so opening an uploaded HTML, SVG, XML or JavaScript file downloads it instead of
running its scripts on the media origin. Edge copies store the headers, and copies cached before this release get
them on the way out. Playback, captions, images, PDFs and range requests are unchanged.
