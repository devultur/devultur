---
"@devultur/convex": patch
"@devultur/core": patch
"@devultur/react": patch
"@devultur/self-host": patch
---

Shipped guides, a lightweight hooks entry, typed function results and Node-resolvable component imports.

- Each package ships the guides its README links to, in `docs/guides/` (`@devultur/react` and `@devultur/convex` ship `video-player.md`). The READMEs name the shipped path next to the GitHub link.
- `@devultur/convex/react/hooks` exports `DevulturContext`, `DevulturApiContext`, `DevulturProgressContext`, `useDevultur`, `useDevulturOptional`, `useDevulturApi`, `useDevulturProgress`, `useMediaUrl` and `useVideoProps` without the components or Convex's client: an app importing only `useDevulturOptional` from it bundles under 1 kB gzipped. They are the same objects `@devultur/convex/react` exports (which now exports the contexts too), so a provider from one fills the hooks of the other.
- The functions `defineDevulturFunctions` and `Devultur.exposeApi` register return the component's results instead of `any`: `getMedia` is a `MediaDocument | null` (a `MediaRecord` with `_id` and `_creationTime`), `listMediaPage` and `searchMedia` a `PaginationResult<MediaDocument>`, and so on (`DevulturFunctionResults`). The `Devultur` methods that returned `any` are typed the same way. Arguments are unchanged. Nothing changes at runtime, but code that relied on `any` (an unguarded `null`, a field the record doesn't have, or an app type the results don't match) now fails to compile.
- The compiled component (`dist/component`) imports its own modules with a `.js` extension, so convex-test runs it from `node_modules` without `server.deps.inline`.
