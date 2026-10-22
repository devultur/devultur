---
"@devultur/convex": minor
---

Render PDF previews with pdf.js. Under a `PdfPreviewProvider` (with `loadPdfjs` from the new `@devultur/convex/pdfjs`
entry, or any loader), `<Preview>` draws PDFs on `<canvas>` pages with the pdf.js legacy build: pages render lazily as
they near the viewport, within a 5,242,880-pixel canvas cap on mobile, from the bytes of the verified fetch (pdf.js
never gets a URL), with `enableScripting: false` and each page's text for screen readers. `pdfWorkerSrc` (or the
provider's `workerSrc`) sets the worker. Without pdf.js, PDFs keep rendering in an `<iframe>`. New `<PdfThumbnail>`
draws page 1 on a small canvas, fetching only once visible. `pdfjs-dist >=6.2.108` is an optional peer dependency.
