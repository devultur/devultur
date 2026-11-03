---
"@devultur/core": minor
"@devultur/self-host": minor
"@devultur/convex": minor
---

Download grants: a capability over one private file that another system can use to issue short download links, without holding a credential of the Worker.

- `files.createDownloadGrant(key, { expiresIn?, link?: { maxExpiresIn?, maxUses? }, maxLinks?, canDelete?, metadata? })` returns the grant (`dvg_…`, shown once) and its public id (`dgr_…`). It lives as long as its file (30 days at most without a TTL) and dies with it, including when the key is overwritten. `files.listDownloadGrants(key)` and `files.revokeDownloadGrant(id)` manage them.
- `createGrantClient(grant, baseUrl)` is what the grant's holder uses: `head()` (with `encrypted`, the grant's `metadata` and its expiry), `createDownloadLink()` within the caps (`400 link_exceeds_grant`, `410 grant_exhausted`), `delete()` when the grant allows it (behind the lock guard) and `revoke()`. The grant travels only in `Authorization: Bearer`; in `?token=` it's refused (`401 grant_in_query`).
- `DownloadLink` gains `id`, the link's opaque id.
- `@devultur/self-host`: the `DownloadGrants` Durable Object (binding `DOWNLOAD_GRANTS`, a `v2` migration with `new_sqlite_classes = ["DownloadGrants"]`), routes `/v1/token/grant` (owner) and `/v1/grant/*` (bearer) in `downloadLinks()`, the `authorizeGrant` plugin hook, `download-grant` as a `CredentialKind`, and `issuedGrant`, `revokedGrant` and `grantDeletedKey` in the route result. Without the binding the grant routes answer `501`.
- `@devultur/convex`: the new error codes, with English and Spanish labels.
