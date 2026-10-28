---
"@devultur/convex": patch
---

Move `useDevultur`, `useDevulturApi` and `useDevulturProgress`, with their error messages and
`DevulturCapabilityError`, out of the contexts' chunk. An app that imports only `useCanDeliver` or
`useDevulturOptional` from `@devultur/convex/react/hooks` and lazy-loads `@devultur/convex/react` now loads about
0.14 kB gzip of Devultur code first, down from 0.42 kB. The public API, the error types and their messages are
unchanged.
