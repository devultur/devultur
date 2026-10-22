---
"@devultur/convex": patch
---

`<Preview>`, `<PdfThumbnail>` and `PdfPreviewProvider` take `labels` (`Partial<PreviewLabels>`), so every string a
preview shows or announces can be localized: the PDF document and page names, the loading announcement, the page-cap
note, the default fallback's link text and per-error `title`, and the thumbnail's name. A component's `labels` win over
the provider's, which win over `defaultPreviewLabels` (English). `<Preview>`'s `fallback` can also be a function of the
`MediaFetchError` that caused it (`unsupported_type` when the type doesn't preview inline, `null` when no fetch was
refused). Without `loading`, a visually hidden `role="status"` now announces `labels.loading`.
