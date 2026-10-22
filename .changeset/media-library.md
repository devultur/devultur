---
"@devultur/convex": minor
---

Search and browse the media library, and pick media from it.

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
- `<MediaLibrary>` takes `selectedKeys` (a controlled selection), `multiple` (`aria-multiselectable`) and `filter`.
- `<MediaPicker value? onChange accept? type? multiple? labels?>`: uploads (per-file progress, cancel, retry and
  errors through `describeDevulturError`), browses the library and shows the selection (`<AttachmentCard>` with an
  inline `<Preview>`), returning `DevulturMedia` references; a new upload is selected, and under a
  `PdfPreviewProvider` with pdf.js a PDF's `pageCount` is read before it uploads. `accept` filters the uploads and the
  library. No dialog of its own: lay out `MediaPicker.Upload`, `.Library` and `.Selection`, or pass a render prop
  (`useMediaPicker()` gives the same state). A polite live region announces uploads and selections, and focus moves
  to the selection after an upload or a removal. `defaultMediaPickerLabels` in English; `mediaPickerLabels` and
  `mediaLibraryLabels` in `@devultur/convex/locales/es`.
