---
"@devultur/convex": minor
---

Search and browse the media library.

- `searchMedia({ search, type?, paginationOpts })` pages through the records whose title or filename matches, on the
  `search_text` index, optionally of one type; a blank search lists newest first. In `defineDevulturFunctions`
  (guarded) and `Devultur.exposeApi`, and `devultur.searchMedia(ctx, args)` from your server.
- `devultur.backfillSearchText(ctx, { batchSize? })` (or `npx convex run --component devultur
  library:backfillSearchText`) gives records from before 1.4.0 their `searchText`, in self-scheduling batches. Any
  write to such a record also fills it.
- `useMediaLibrary({ type?, search?, pageSize? })` from `@devultur/convex/react`: `usePaginatedQuery` over
  `listMediaPage` and `searchMedia`, with the search debounced 250 ms and pagination reset on a new query.
- `<MediaLibrary onSelect>`: a searchable, keyboard-navigable grid (listbox, roving tab stop, arrow keys, Home, End)
  with a type filter, image thumbnails, icons, loading, empty and error states, `labels`, `selectable`,
  `renderItem`, opt-in `pdfThumbnails`, class names and `--devultur-library-*` custom properties.
- `useDevulturApi()` returns the `api` passed to `<DevulturProvider>`, whose `DevulturApi` type gains
  `listMediaPage` and `searchMedia`.
