---
"@devultur/self-host": minor
---

Refuse to overwrite locked files. The upload PUT, multipart create and complete, captions and re-transcodes answer `409 retention_active` when they would replace a locked file or a retained output of a locked video. New outputs and new caption locales are still allowed, and so is the first transcode of a locked video. `POST /v1/upload` with `overwrite: true` refuses a locked asset before any bytes are sent. Every upload write is conditional on the object the check saw. If it changed in between, the upload answers `409 write_conflict` and removes the encryption key it created, and the client retries.

While a transcode job is in progress (status `queued` or `running`), the runner's credential can still rewrite that job's own outputs, so an upload retry doesn't fail on a locked video. From `transcode.complete` on, those outputs are protected like any other derived file.

A first transcode of a locked video that failed can be retried, and the new job may overwrite the partial outputs. Only a transcode that completed blocks re-transcoding.
