---
"@devultur/core": patch
"@devultur/self-host": patch
---

Object lock fixes from a second security review:
- **Edge cache:** an owner read (Worker secret) never reads or stores a public edge copy, and gets the private form of the file's `Cache-Control`, so an expired file and the `x-devultur-lock-*` headers never reach a shared cache. A copy's TTL is capped at the file's `expiresAt`, and a copy found past it is ignored (`410`).
- **Lock records outlive deletes:** deleting or overwriting a file leaves its lock record in place, inert (it's bound to the replaced version). A hold or retention set on the new file right after the write is no longer lost.
- **Bounded listings:** `GET /v1/assets` reads at most 32 lock records (`MAX_EXPIRED_LOOKUPS`) per page for expired entries. Past that, the page ends early with a cursor that resumes after its last entry.
- **Derived files expire:** transcode outputs (HLS, MP4, thumbnails, poster, storyboard) inherit the earliest `expiresAt` of the video's raws, and captions the one of their source, so they answer `410` with it.
- **Encryption keys of replaced versions:** an overwrite deletes the replaced version's key, and a delete sweeps every key of the object (never an asset nested under its path).
- **Unreadable lock records:** a lock record (or upload `lock` metadata) that can't be read stays held. A release is skipped with `lock_record_unreadable` (new `HoldSkip` reason in `@devultur/core`), and `PUT /v1/lock/<key>` answers `409 lock_record_unreadable`.
- **Docs:** the expiry cleanup is the operator's to run (none ships), listings expose retention to whoever can list, and how to repair an unreadable lock record.
