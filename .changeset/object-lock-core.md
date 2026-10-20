---
"@devultur/core": minor
"@devultur/server": minor
---

Add object lock types and rules: `Retention` (`governance` or `compliance`, a fixed `until` or a `period`, and `derivatives`) and `hold`, resolved with `resolveLock` (resource override, then app default, then off) and validated with `validateLock`. Pure helpers `effectiveUntil`, `isLocked` and `canChange` implement the expiry and change rules. `DevulturApiError` gains `details` with the response body's extra fields, such as the `key`, `mode`, `until` and `hold` of a `409 retention_active`. The Worker doesn't enforce locks yet.
