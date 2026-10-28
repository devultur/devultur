---
"@devultur/self-host": patch
---

Every token signed before the claim rename stops working: viewer tokens, upload tokens and job tickets. The Worker no
longer reads their claim names (`pid`, `ppx`, `pfx`, `vis`, `mxb`, `mxf`, `fttl`, `ctx`, `scopes`) as the current
ones (`aud`, `res`, `visibility`, `max_bytes`, `max_files`, `file_ttl`, `context`, `scope`). `verifyViewerToken`, a
public export, now refuses a token that carries `pid`, `ppx` or `scopes`, so it is never served without the storage
prefix, path prefix or scopes it was bound to. Those three names are reserved: an `issueCredential` hook that adds one
makes the request fail with an error that names the claim.
