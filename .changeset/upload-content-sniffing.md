---
"@devultur/self-host": minor
---

**Behaviour change:** uploads are checked against their declared Content-Type. The Worker reads the first 4 KB of the
plaintext and compares them with a signature table (PDF, PNG, JPEG, GIF, WebP, AVIF, HEIF, MP4/MOV/M4A, WebM/Matroska,
MP3, Ogg, WAV, FLAC, zip-based documents, plain text, CSV and JSON). A mismatch, including any "PDF", image or text
upload that is really HTML, SVG or XML, answers `415 content_type_mismatch` (with `declared` and `detected`) and stores
nothing. For a multipart upload, part 1 is checked when it arrives: a mismatch aborts the upload and deletes its pending
and encryption key, and `complete` answers `409 content_unverified` until part 1 has passed. Types outside the table
keep their declared type, and a transcode's outputs are never checked.

The new `contentSniffing` rule (`defaultPlugins({ contentSniffing })`) picks what a mismatch gets: `"reject"` (the
default), `"octet-stream"` (a single PUT is stored as `application/octet-stream`; multipart is still rejected) or
`"off"`.

Delivery also adds `Cross-Origin-Resource-Policy: cross-origin` to public media, and the sandbox policy for risky types
is now `Content-Security-Policy: sandbox; default-src 'none'`.
