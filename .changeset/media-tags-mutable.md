---
"@devultur/core": patch
---

`DevulturMedia.tags` is a `string[]` again instead of a `readonly string[]`, so a media reference returned by an upload can be passed to a mutation whose argument uses `dv.media()`. Under 1.4.0 that failed to typecheck with TS2322.
