---
"@devultur/self-host": minor
---

Lock files at upload and refuse to delete them while locked. An upload takes `lock` (`retention` and `hold`) or `hold` from the request, from the upload token (`lock` on `POST /v1/token/upload`, a minimum the request can't loosen) or from `config.lock`, and stores it on the object in the same write. `DELETE /v1/media/:key` and `DELETE /v1/media/videos/:videoId` answer `409 retention_active` with `{ key, mode, until, hold }` while the file, or for a video's derived files its original (`retention.derivatives: "inherit"`), is locked; deleting the encryption keys is refused the same way. A locked original is kept after a transcode even with `deleteOriginalOnSuccess`. Keys under `__lock/` and `__lock-audit/` are reserved.
