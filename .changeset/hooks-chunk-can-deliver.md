---
"@devultur/convex": patch
"@devultur/core": patch
"@devultur/react": patch
"@devultur/self-host": patch
---

A smaller shared chunk behind `@devultur/convex/react/hooks`, and `useCanDeliver()`.

- The contexts and the hooks that only read them (`useDevultur`, `useDevulturOptional`, `useDevulturApi`, `useDevulturProgress`, `useCanDeliver`) now sit in a chunk of their own, apart from `useMediaUrl`, `useVideoProps` and `@devultur/core`'s URL helpers. An app that imports `useDevulturOptional` from `@devultur/convex/react/hooks` and lazy-loads `@devultur/convex/react` now loads 0.4 kB gzipped of devultur code up front instead of 3.2 kB (minified, with Rolldown). The contexts are still the same objects in both entries.
- `useCanDeliver()`, from `@devultur/convex/react/hooks` and `@devultur/convex/react`, is `true` only under a provider with a non-empty `baseUrl`, where `useMediaUrl`, `useVideoProps` and `url()` can build URLs. `useDevulturOptional()` is non-null under a `<DevulturProvider>` without `baseUrl` too. A private media also needs the viewer token, which `tokenStatus` reports.
