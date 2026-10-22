---
"@devultur/core": minor
"@devultur/self-host": minor
"@devultur/convex": minor
---

Record and edit media metadata.

- The Worker reads an image's width and height from its header bytes on a single PUT (PNG, JPEG, GIF, WebP, AVIF),
  keeps them in the object's metadata and returns them on GET/HEAD (`x-devultur-image-width` / `-height`,
  `IMAGE_WIDTH_HEADER` / `IMAGE_HEIGHT_HEADER`). `files.head()` returns them as `width` / `height`.
- The component's `media` records gain optional `title`, `alt`, `tags`, `pageCount` and `searchText` (title and
  filename, lowercased, behind a `search_text` search index). Records from before stay valid; no migration.
- `confirmUpload` records the Worker's image size over the client's, and takes an optional `pageCount` (PDFs). The
  client's `width`, `height` and `pageCount` are hints: whole numbers from 1 to 100,000; another value is dropped
  (and logged) and the upload is recorded without it.
  `upload(file, { pageCount })` passes it, and `countPdfPages(file)` from `@devultur/convex/pdfjs` counts it with pdf.js.
- `updateMediaMeta({ key, title?, alt?, tags? })`, in `defineDevulturFunctions` (guarded) and `Devultur.exposeApi`, and
  `devultur.updateMediaMeta(ctx, args)` from your server. Trimmed, tags deduplicated; title up to 200 characters, alt up
  to 1,000, up to 20 tags of 50. `invalid_media_metadata` has English and Spanish labels.
- `DevulturMedia`, `dv.media()` and `mediaFromRecord` gain optional `title`, `alt`, `tags`, `sizeBytes`, `duration` and
  `pageCount`. `<Image>` uses `media.alt` when no `alt` is passed.
