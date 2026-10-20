---
"@devultur/self-host": minor
---

Code that runs in your Worker (a plugin route, a scheduled sweeper) can now delete whole prefixes from the R2 binding without destroying retained files.
- `deletePrefixRespectingLocks({ mediaBucket, keysBucket?, prefix, root?, cursor?, batchSize?, maxSubrequests? })` deletes what's free under a storage prefix the way `DELETE /v1/media/:key` does (with its encryption keys and its variants'; an emptied video folder also loses its HLS key and transcode-completed marker) and keeps what's locked, with its keys, variants and lock records. It returns `{ deletedCount, deletedBytes, deletedKeyCount, retainedCount, retainedBytes, retained, cursor?, subrequests }` and stops before `maxSubrequests` bucket calls (default 500) with a `cursor` to resume from.
- `readObjectLock({ mediaBucket, root? }, storageKey)` returns the lock in force on one stored object (`{ locked, hold, until?, mode?, unreadable?, lockedBy? }`), resolved like the routes do: the upload lock or the version-bound lock record, unreadable records held, a video's files inheriting from its raws, an image's variants from it.
- `retainedSummary({ mediaBucket, prefix, cursor? })` answers "can this be deleted?" without deleting: `{ scannedCount, retainedCount, retainedBytes, latestUntil?, hasHold, cursor?, subrequests }`, bounded the same way.

Keys are full storage keys; the storage prefix each lives under is read from the key, or passed as `root`. See "Deleting a prefix from your own code" in the object lock guide.
