---
"@devultur/convex": patch
---

`DevulturProvider` takes `tokenArgs`, extra arguments sent with `sessionSecret` on every viewer token issuance (first,
renewal and re-issue). When they change by value, the provider drops the current token and issues a new one, and a
response for the previous arguments is ignored. `issueViewerToken` lets an app pass its own token action in place of
`api.issueViewerToken`, for example one that checks access to a workspace before issuing.
