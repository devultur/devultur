---
"@devultur/self-host": minor
---

Code that runs in your Worker (a plugin route, a scheduled sweeper) can now delete whole prefixes from the R2 binding without destroying retained files.
- `deletePrefixRespectingLocks({ mediaBucket, keysBucket?, prefix, root?, cursor?, batchSize?, maxSubrequests? })` deletes what's free under a storage prefix the way `DELETE /v1/media/:key` does (with its encryption keys and its variants'; an emptied video folder also loses its HLS key and transcode-completed marker, sparing keys of uploads in flight) and keeps what's locked, with its keys, variants and lock records. It returns `{ deletedCount, deletedBytes, deletedKeyCount, retainedCount, retainedBytes, retained, skippedCount, cursor?, subrequests }`. It never makes more than `maxSubrequests` bucket calls (default 40, under the Workers Free plan's 50 subrequests per request; raise it on a paid plan), never stops halfway through an object, and returns a `cursor` to resume from.
- It takes no `now`: locks are judged by the real clock, so no option can make a retention read as expired. A cursor works only with the prefix it was returned for; a malformed or out-of-bounds one throws `RangeError` before any bucket call.
- Lock records and audit objects are never touched, and a key not laid out like the Worker's (no `public`/`private` segment where expected) is kept and reported with `unrecognized: true`.
- `readObjectLock({ mediaBucket, root?, now? }, storageKey)` returns the lock in force on one stored object (`{ locked, hold, until?, mode?, unreadable?, unrecognized?, lockedBy? }`), resolved like the routes do: the upload lock or the version-bound lock record, unreadable records held, a video's files inheriting from its raws and an image's variants from it (both free under `original-only`).
- `retainedSummary({ mediaBucket, prefix, cursor?, now? })` answers "can this be deleted?" without deleting: `{ scannedCount, retainedCount, retainedBytes, latestUntil?, hasHold, cursor?, subrequests }`, bounded the same way.

Keys are full storage keys; the storage prefix each lives under is read from the key, or passed as `root`. See "Deleting a prefix from your own code" in the object lock guide.
