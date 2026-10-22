---
"@devultur/convex": patch
---

Add `@devultur/convex/locales/es-formal`: formal Spanish («usted») under the same names as `locales/es`, which now
also exports `previewLabels`. `<Preview>`'s function `fallback` now always receives a `MediaFetchError`, never
`null`: `page_cap` (with `details: { shown, total }`) for the link after the `maxPages` note, `render_failed` when
pdf.js can't open a PDF or a video can't be played, and `http_error` without `status` for a network failure. Both
codes have English and Spanish labels.
