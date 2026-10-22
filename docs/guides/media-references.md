# Media references & delivery

Store a typed DevulturMedia reference, render it with <Image>, and control public vs private delivery.

A single typed reference flows from upload to storage to render — you never touch a
token, a raw URL, or a query string by hand.

## The `DevulturMedia` reference

Every upload resolves to a serializable, typed reference:

```typescript
type DevulturMedia = {
  id: string;                          // resource id
  kind: "image" | "video" | "file";
  visibility: "public" | "private";
  filename?: string;                   // original name (display / download)
  width?: number;                      // intrinsic dimensions (no layout shift)
  height?: number;
  key?: string;                        // the uploaded object's key (informational)
};
```

Store the **reference**, not a URL. The delivery path is derived from it, so devultur
can change how URLs are built without touching your data — and you never persist a
URL that can go stale or leak a token.

## Store it in Convex

The `dv.media()` validator types and validates the reference in your schema — a
malformed media is rejected at the mutation, not at the `<img>`:

```typescript
// convex/schema.ts
import { dv } from "@devultur/convex";

export default defineSchema({
  courses: defineTable({
    title: v.string(),
    thumbnail: dv.media("image").optional(), // typed, not v.string()
  }),
});
```

`dv.media()` accepts any kind; `dv.media("image")` restricts it.

## Upload returns a reference

In React, `upload()` captures image dimensions in the browser and returns the
reference ready to store:

```tsx
import { useDevultur } from "@devultur/convex/react";

const { upload } = useDevultur();

async function onFile(file: File) {
  const thumbnail = await upload(file);                       // DevulturMedia
  const workbook  = await upload(file, { visibility: "private" }); // override
  await saveCourse({ thumbnail });
}
```

`upload()` also takes `onProgress` (`{ loadedBytes, totalBytes, fraction }` of the PUT) and an abort `signal`. The
reference it returns carries the uploaded object's `key` (`thumbnail.key`), an optional field of `DevulturMedia` and
`dv.media()`, so it stores as-is and references saved without it stay valid. Delivery never reads it: paths are
derived from the other fields. With the Convex component, every upload is also recorded in its media library
(`listMedia`); see [Upload progress and the media
library](../../packages/convex/README.md#media-library).

## Render with `<Image>`

`<Image>` composes the URL, injects the viewer token when needed, and works inside a
`.map()` — no wrappers, no hook-in-a-loop:

```tsx
import { Image, DownloadLink } from "@devultur/convex/react";

{courses.map((course) => (
  <Image
    media={course.thumbnail}          // DevulturMedia | null
    alt={course.title}
    width={512}
    format="webp"                     // typed transforms
    fallback={<Placeholder />}        // rendered when media is null
    externalFallback="https://images.unsplash.com/…"
  />
))}

// Force a download with the original filename:
<DownloadLink media={file}>Download</DownloadLink>
```

For background images, pass `render` instead of forcing an `<img>`:

```tsx
<Image media={hero.image} render={<div className="hero aspect-[4/3]" />} />
```

### Previewing private files

`<Preview>` shows a file inline, picking the element from its content type: an image in an `<img>`, a PDF on
`<canvas>` pages with pdf.js (or in an `<iframe>` without it, see [PDFs](#pdfs-with-pdfjs)), audio in `<audio controls>`, plain text, CSV and JSON as text in a `<pre>`, and video in the streaming
`<VideoPlayer>`. Anything else renders `fallback` (by default a `<DownloadLink>`):

```tsx
import { Preview } from "@devultur/convex/react";

<Preview
  media={document.file}           // DevulturMedia | null
  maxBytes={20_000_000}           // larger files render the fallback
  loading={<Spinner />}
  className="h-[80vh] w-full"
/>
```

The content type comes from `contentType` when you pass it (e.g. the type you stored with the file), otherwise from
the filename's extension. Images, PDFs and audio are capped at 50 MiB (`maxBytes`) and text at 1 MiB
(`maxTextBytes`); a larger file renders the fallback.

For your own markup, `useMediaObjectUrl` returns an in-memory URL for any media:

```tsx
import { useMediaObjectUrl } from "@devultur/convex/react";

const { objectUrl, isLoading, error } = useMediaObjectUrl(document.file, {
  enabled: isSelected,            // nothing is fetched until the row is selected
  contentType: "application/pdf", // the response must agree; the object URL is created with this type
  maxBytes: 20_000_000,           // refused by Content-Length, and while streaming
});
if (objectUrl) return <iframe src={objectUrl} title={document.file.filename} />;
```

Private media is fetched with the session header (one token re-issue and retry on a `401 session_mismatch`, as
`<Image>` does) into an object URL that is revoked when `media` changes and on unmount; the in-flight fetch is
aborted too. Public media returns its delivery URL without fetching, unless you pass `contentType`: then it's
fetched and verified like private media. `error` is a `MediaFetchError` with a stable
`code`: `http_error` (with `status`), `too_large`, `type_mismatch` or `unsupported_type`.

**Security.** A `blob:` URL is same-origin with your app: an uploaded HTML or SVG file rendered from one runs its
scripts with your app's cookies and storage. So only an allowlist renders inline:

| Renders as | Content types |
| --- | --- |
| `<img>` | `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/avif` |
| pdf.js `<canvas>` (or `<iframe>`) | `application/pdf` |
| `<audio>` | `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/ogg`, `audio/wav`, `audio/webm`, `audio/flac` |
| `<pre>` (text, escaped) | `text/plain`, `text/csv`, `application/json` |
| `<VideoPlayer>` | video media (streamed, never a blob) |

Everything else, including `text/html`, `image/svg+xml`, `application/xml` and `application/xhtml+xml`, falls back to
a download. The file's known type and the response's `Content-Type` must both be allowlisted and render the same way
(a `.pdf` served as `text/html` falls back), and the blob is created with the allowlisted type, never the server's
verbatim: the client-side counterpart of `X-Content-Type-Options: nosniff`. Without a `contentType` option,
`useMediaObjectUrl` keeps the response's type only when it's on the list and labels anything else
`application/octet-stream`, which downloads instead of rendering.

`<Preview>` never frames a URL whose type it hasn't verified: public PDFs and audio are fetched into a blob the same
way. Only a public image keeps its delivery URL, because an `<img>` never runs script. The self-host Worker adds its own
layer: anything outside its safe-inline list is served sandboxed and as an attachment (see
[Security](security.md#serving-uploaded-files-safely)).

#### PDFs with pdf.js

Install [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist) (an optional peer dependency, `>=6.2.108`) and wrap
the app, or just the pages with previews, in a `PdfPreviewProvider`:

```bash
pnpm add pdfjs-dist
```

```tsx
import { PdfPreviewProvider } from "@devultur/convex/react";
import { loadPdfjs } from "@devultur/convex/pdfjs";

<PdfPreviewProvider pdfjs={loadPdfjs}>
  <Preview media={document.file} className="w-full" />
</PdfPreviewProvider>
```

Why: the browser's own viewer isn't the same everywhere. iOS Safari shows only the first page of a PDF in an
`<iframe>`, and a sandboxed frame blocks Chrome's viewer altogether. With pdf.js every browser gets the same
scrollable pages:

- Pages render to `<canvas>` lazily, as they near the viewport, at the container's width and the screen's pixel
  density, capped at 5,242,880 canvas pixels on phones and tablets (larger canvases render blank on iOS).
- pdf.js gets the bytes of the same verified fetch, never a URL, so it fetches nothing itself and never sees a token.
- No annotation layer is built and `enableScripting: false` is passed, so PDF JavaScript never runs (versions before
  6.2.108 could run it with scripting on, CVE-2026-16633). `isEvalSupported: false` is passed too, though pdf.js 6
  no longer has that `eval` path (CVE-2024-4367).
- Each page's text is in the page for screen readers; the document is labeled with its title and page count. Text
  isn't selectable.
- At most `maxPages` pages render (default 500): a small file can declare millions. Past it, a "showing the first N of
  M pages" note and `fallback` follow the pages.
- The document and its worker are destroyed, and pending renders cancelled, when `media` changes and on unmount.

`loadPdfjs` imports the **legacy build** (`pdfjs-dist/legacy/build/pdf.mjs`), which runs on Safari and iOS 18+; the
modern build needs iOS 26.2. It lives in its own entry, `@devultur/convex/pdfjs`, so apps without `pdfjs-dist` never
bundle an import they can't resolve. Without a provider, or when the import fails, PDFs render in the `<iframe>`
below, from the same bytes.

`<PdfThumbnail>` draws only page 1 on a small canvas, for lists and upload queues. Nothing is fetched until the row
nears the viewport; without pdf.js it renders `fallback`:

```tsx
import { PdfThumbnail } from "@devultur/convex/react";

<PdfThumbnail media={row.file} width={64} fallback={<FileIcon />} />
```

**The worker.** `loadPdfjs` points `GlobalWorkerOptions.workerSrc` at
`new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url)` unless you set one. Bundlers resolve that
differently, so set it from your own code when the default doesn't load (`workerSrc` on the provider, or
`pdfWorkerSrc` on one `<Preview>` / `<PdfThumbnail>`):

- **Vite and TanStack Start**: import the worker as an asset.

  ```tsx
  import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

  <PdfPreviewProvider pdfjs={loadPdfjs} workerSrc={workerSrc}>
  ```

  Vite pre-bundles dependencies, which breaks `import.meta.url` inside them in dev; the `?url` import avoids that.
- **Next.js**: render previews on the client only (`dynamic(() => import("./preview"), { ssr: false })`, or a
  `"use client"` component). Next 15+ usually resolves the default worker URL without config; if the worker
  doesn't load (or on older versions), copy `pdf.worker.min.mjs` into `public/` and pass
  `workerSrc="/pdf.worker.min.mjs"`.
- **Anything else**: serve `node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs` as a static file and pass its URL.

To load pdf.js your own way (another build, a CDN you host), pass any loader:
`pdfjs={() => import("pdfjs-dist/legacy/build/pdf.mjs")}`.

**The `<iframe>` fallback.** It has no `sandbox`: browsers refuse to run their PDF viewer in a sandboxed frame. A
blob typed `application/pdf` always opens in the PDF viewer, so a body that isn't a PDF fails to parse instead of
running. The frame has `referrerPolicy="no-referrer"`.

#### Content Security Policy

If your app sends a CSP, previews need, on the pages that show them (not app-wide):

| Directive | Needed for |
| --- | --- |
| `img-src blob:` | images |
| `media-src blob:` | audio |
| `worker-src 'self' blob:` | pdf.js's worker (`'self'` for a same-origin worker file; add its origin if you host it elsewhere) |
| `frame-src blob:` | only the `<iframe>` fallback, when pdf.js isn't installed |

pdf.js needs no `'unsafe-eval'`; `'wasm-unsafe-eval'` lets it decode JPEG 2000 and JBIG2 images with WebAssembly
(it falls back to JavaScript without it).

### Imperative escape hatch

For handlers or a hand-built `srcset`, use the non-hook builder from context:

```tsx
const { url } = useDevultur();
const href = url(course.thumbnail, { download: true });
```

## Video

For the full pipeline (queued → processing → ready/failed), `useVideoState` returns a
**discriminated union** you render with an exhaustive `switch` — no boolean bag, no
`as any`, and adding a phase is a compile error until you handle it:

```tsx
import { VideoPlayer } from "@devultur/react";
import { useVideoState } from "@devultur/convex/react";

function Lesson({ video }) {
  const state = useVideoState(video, { locales: ["es-CO", "en"] });
  switch (state.phase) {
    case "idle":       return null;
    case "queued":     return <Status>Requesting…</Status>;
    case "processing": return <Status>{state.step} {state.percent}%</Status>;
    case "failed":     return <Status error>{state.message}{state.retriable && <Retry />}</Status>;
    case "ready":      return <VideoPlayer {...state.playerProps} onProgress={save} />;
  }
}
```

- `processing` carries a typed `step` (`downloading | encoding | uploading | captioning`) and `percent`.
- `failed` carries a categorized `reason` (`invalid_input | unsupported_codec | timeout | capacity | internal`) and `retriable` — decide the message and whether to offer a retry. A machine that never boots fails in ~90s, not 5 minutes.
- `ready` carries the `media` ref, `playlist`, `captions`, `duration`, and `playerProps` ready to spread into `<VideoPlayer>` (token-transparent).

Just the player props from a ready video? `useVideoProps(media, { locales })`. Caption text
(e.g. for AI metadata)? `const vtt = await getCaptionsText(video, "es-CO")` — auth-transparent.

## Delivery without React

`getMediaUrl` and `publicUrl` build URLs from a reference anywhere:

```typescript
const url = media.getMediaUrl(lesson.video);          // token-transparent

const cover = media.publicUrl(course.thumbnail, { width: 512, format: "webp" });
```

`publicUrl` only accepts `DevulturMedia<"public">` — passing a private reference is a
**compile error**, so paid content can't leak to an `og:image`:

```typescript
publicUrl(course.thumbnail);    // ✅ public
publicUrl(lesson.privateAsset); // ✗ type error
```

## Public vs private delivery

Visibility is decided once, at upload, and travels in the reference:

- **Public** — a stable, cacheable, tokenless URL. Works in the browser, SSR,
  `og:image`, emails, and social crawlers (WhatsApp/X/Google).
- **Private** — the `DevulturProvider` issues and auto-renews a short-lived viewer
  token; `<Image>` and `<VideoPlayer>` read it from context. You never pass it. A
  request without a valid token gets a `401`.

Because the reference carries its visibility, `<Image media={ref} />` picks
token-or-no-token automatically — the render never knows about tokens.
