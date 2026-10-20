---
"@devultur/self-host": minor
---

Change locks after upload, and audit every lock event.
- `GET /v1/lock/:key` reads an object's lock. `PUT /v1/lock/:key` sets or extends it (`mode`, `until`, `period`, `derivatives`). These are bearer-only control routes.
- Compliance only extends. A governance retention can be shortened or removed (`remove: true`) only with `bypassGovernance` and the approval of an `authorizeLockChange` plugin hook. Otherwise the answer is `403 lock_privilege_required`.
- Changes go to a compare-and-swap sidecar under `__lock/` (a concurrent change gets `409 lock_conflict`). The sidecar is bound to the object version it was written for.
- Every change, rejected delete or overwrite, and retained original is audited: a structured log line, a create-only record under `__lock-audit/{yyyy-mm-dd}/`, and the `onLockAudit` hook.
- Owner reads carry `x-devultur-lock-until` and `x-devultur-lock-hold`.
- A completed transcode is now recorded durably. A locked video can be re-transcoded until a transcode completes, and not after.
