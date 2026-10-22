---
"@devultur/convex": minor
---

Document link, attachment card and responsive images.

- `<DocumentLink media download? labels?>`: a link to a file, named by its `title` or filename. Public files link to
  their delivery URL; private files download through the session-header fetch `<DownloadLink>` uses.
- `<AttachmentCard media onOpen? preview? labels? locale?>`: an accessible `<article>` with an icon by type, the name,
  type, size, a PDF's page count or a duration, a download link and an optional "Open preview" button that calls
  `onOpen`. Labels and formatters are English by default (`defaultAttachmentLabels`, `formatFileSize`,
  `formatDuration`); Spanish ones ship as `attachmentLabels` in `@devultur/convex/locales/es`.
- `<Image widths sizes>` builds a `srcset` from the Worker's transforms for public images, defaults to
  `loading="lazy"` and `decoding="async"`, and fetches one width for private images (the largest up to twice the
  width `sizes` gives it). Without `widths`, `<Image>` is unchanged, and an explicit `srcSet` is passed through and
  wins over the one `widths` builds.
