---
"@devultur/self-host": minor
---

Set and release holds. `POST /v1/lock/hold` takes `{ hold, keys }` (up to 50 keys) or `{ hold, prefix, cursor? }` (50 objects per page) and answers `{ updated, skipped, cursor? }`. It is the one way to change a hold, including for a single object. A hold never touches the retention. Releasing it starts a `period` at release time; without a retention, the object is free again. Each page goes through `authorizeLockChange` (`hold` or `release`), and every object changed is audited. An upload that carries a lock now gets its first audit record (`set`, with the uploader as actor).
