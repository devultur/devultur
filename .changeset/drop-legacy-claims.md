---
"@devultur/self-host": patch
---

Stop reading the token claim names used before 1.0 (`pid`, `ppx`, `pfx`, `vis`, `mxb`, `mxf`, `fttl`, `ctx`,
`scopes`) as the current ones: no published version signs them. A token that still carries `pid`, `ppx` or
`scopes` is refused, so it is never served without the storage prefix, path prefix or scopes it was bound to.
