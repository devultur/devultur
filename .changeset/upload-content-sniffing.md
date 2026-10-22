---
"@devultur/self-host": minor
"@devultur/core": minor
---

Uploads are checked against their declared Content-Type. The Worker reads the first 4 KB of the plaintext and compares
them with a signature table (PDF, PNG, JPEG, GIF, WebP, AVIF, HEIF, MP4/MOV/M4A, WebM/Matroska, MP3, Ogg, WAV, FLAC,
zip-based documents, plain text, CSV and JSON). Types outside the table keep their declared type, and a transcode's
outputs, written with the runner's own types, are never checked.

**The default (`contentSniffing: "scriptable"`) only rejects markup:** a "PDF", image or text upload that is really
HTML, SVG or XML answers `415 content_type_mismatch` (with `declared` and `detected`) and stores nothing. Any other
mismatch is stored with its declared type, as before. Every mismatch is logged as
`[content-sniff] {declared, detected, key, action}`. You can opt into `"reject"` (415 for every mismatch),
`"octet-stream"` (a mismatching single PUT is stored as `application/octet-stream`) or `"off"` with
`defaultPlugins({ contentSniffing })`. The security guide lists the real files the stricter modes turn away.

For a multipart upload, every upload of part 1 is checked: a rejected one aborts the upload and deletes its pending
upload and encryption key. `complete` answers `409 content_unverified` unless it names the part 1 that was checked.
`uploadMultipart` (`@devultur/core`) makes up to 3 attempts at a complete that gets `content_unverified`, with a
growing delay.

Delivery also adds `Cross-Origin-Resource-Policy: cross-origin` to public media, and the sandbox policy for risky types
is now `Content-Security-Policy: sandbox; default-src 'none'`.
