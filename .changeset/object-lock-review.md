---
"@devultur/core": patch
"@devultur/self-host": patch
---

Object lock fixes from a security review:
- **Nested assets:** deleting an asset no longer deletes the encryption keys of assets nested under its path.
- **Stale lock records:** a lock record is bound to R2's per-write `version`, never the etag (the content's MD5, which repeats). Deleting or overwriting a file also deletes its record, so a stale record can't free a re-uploaded file with identical bytes.
- **Held periods:** while a hold is set, a retention `period` can't be swapped for an `until`. Compliance refuses it, and governance needs the privilege.
- **Period bound:** a `period` is capped at 100 years, and an expiry that can't be computed is refused rather than failing with a 500.
- **Bulk holds:** a hold by prefix skips the Worker's own `__lock/` and `__lock-audit/` records.
- **Hook refusals:** a hold refused by `authorizeLockChange` is audited.
- **Completion marker:** the durable transcode completion marker is written from the job's signed ticket, so it no longer depends on the 24 h launch record.
- **Invalid release times:** a lock record with an invalid hold release time fails closed.
- **Authenticated PUTs:** an authenticated `PUT /v1/upload/<key>` with no pending upload gets `config.lock` (originals only).
- **Expiry:** a locked file is served past its `expiresAt` instead of answering `410`.
- **Conditional writes:** writes over an existing object are also pinned by its upload time, not only its etag.
