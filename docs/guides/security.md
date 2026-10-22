# Security

Bind viewer tokens to a session and encrypt private assets with composable, secure-by-default flags.

Security is a set of composable building blocks. You configure it **once** (a `createWorker` option) and keep consuming media exactly as before — `<Image>`,
`<VideoPlayer {...useVideoProps}>` and `useVideoState` don't change. Nobody pays for what they don't
turn on.

## The `SecurityPolicy`

```typescript
type SecurityPolicy = {
  sessionBinding?: boolean; // L3: bind the token to userId + session fingerprint (UA + nonce). Default ON.
  ipBinding?: boolean;      // L3+: also bind the IP. Opt-in (breaks on mobile/VPN network changes). Default OFF.
  encrypt?: boolean;        // L4: encrypt the private asset at rest / in transit. Opt-in. Default OFF.
};
```

Resolution is **per-flag**: resource override → Worker default → secure-default — the same model as
`visibility`. `sessionBinding ⊂ ipBinding` (enabling IP implies session); `encrypt` is orthogonal.

## L3 — session / IP binding

A viewer token is issued once per session and used for many resources. It carries **two fingerprints**
(`fp` = session, `fpip` = session + IP) plus the Worker's `bind` policy. On private delivery the worker
recomputes the fingerprint the resource requires and compares it — a **stolen token stops working from a
different session or device**.

`sessionBinding` is **ON by default** (closes the leaked-token hole); `ipBinding` is opt-in per
use-case. The client picks nothing: it sends the single token and the gate decides per resource.

### Transparent recovery

When a legitimate session changes UA/IP mid-flight, a bound resource returns `401 session_mismatch`.
`DevulturProvider` **reissues the token once** (fresh fingerprint) and retries — single-flight, no loops.
`<Image>` and `getCaptionsText` recover on their own; the user never sees the interruption. (Recovery on
`<Image>` re-verifies the status with a `fetch`, so the delivery worker must allow CORS from the app
origin — the default `createWorker` does; a custom worker that restricts CORS would lose this recovery.)

## L4 — encryption

Turn on `encrypt` (Worker-wide or per-resource). Only **private** assets are encrypted (public stays
tokenless-cacheable). The mechanism differs by type:

- **Image / file — AES-CTR at rest.** The object is encrypted on upload; the worker decrypts on delivery,
  including `Range` requests and image transforms. Transform variants of an encrypted image are stored
  encrypted too, each with its own key. Transparent to `<img>`. CTR (not GCM) is deliberate: it stays within the Worker memory limit for large files and is
  seek-friendly, giving the confidentiality that is the real goal.
- **Video — AES-128 HLS.** FFmpeg encrypts each segment; the playlist carries a token-gated
  `#EXT-X-KEY` and hls.js decrypts client-side. Real in-transit protection. The **raw original, the
  thumbnail and the `.vtt` captions** of a private video are also encrypted at rest (AES-CTR), so nothing
  about the video is readable from a storage leak; the transcode fetches the raw with a short-lived
  service token and the worker decrypts it in flight. HLS segments themselves are never double-encrypted.

Key material lives in a **dedicated R2 bucket** (`KEYS_BUCKET`), stored under
the object's storage key and a `keyId` (`{storageKey}/{keyId}`). Addressing by `keyId` from day one makes key rotation
an additive change, not a breaking one.

## Configuring it

Pass the policy to the Worker's [rules](self-host.md#rules), and provision the keys bucket if you use `encrypt`:

```typescript
import { createWorker, defaultPlugins } from "@devultur/self-host";

export default createWorker({
  plugins: defaultPlugins({ security: { sessionBinding: true, ipBinding: false, encrypt: true } }),
});
```

```toml
# wrangler.toml: a separate bucket, never public
[[r2_buckets]]
binding = "KEYS_BUCKET"
bucket_name = "media-keys"
```

```bash
wrangler r2 bucket create media-keys
```

Back the keys bucket up and restrict who can reach it: without its key, an encrypted file can't be read again.

Encryption **fails closed**. When the effective policy (Worker default or a resource override) requires encrypting a
private file and `KEYS_BUCKET` isn't bound, the Worker refuses the write with `503 keys_bucket_missing` and stores
nothing, instead of storing it unencrypted. It refuses as early as it can: `POST /v1/upload` before the client sends
any bytes, the upload `PUT` and the multipart create as a backstop, `POST /v1/transcode` before launching, and
`POST /v1/captions` before transcribing. Public files and HLS segments aren't affected. Reading an encrypted file
whose key can't be loaded answers `500`: the Worker never serves ciphertext.

Per-resource overrides travel in the object metadata (set on upload, read on delivery) and resolve
against the Worker default — exactly like `visibility`.

## Serving uploaded files safely

Delivery serves a file with the `Content-Type` it was uploaded with, so an uploaded HTML or SVG file opened from its
URL would render as a page on the media origin and run its scripts. The Worker guards every media and download-link
response:

- `X-Content-Type-Options: nosniff` on every response: the browser never upgrades a declared type into one that
  executes.
- For any type outside the safe-inline list, also `Content-Security-Policy: sandbox; default-src 'none'` (no script,
  an opaque origin, no subresource) and `Content-Disposition: attachment` (opening it downloads it; a stored filename
  is kept).
- `Cross-Origin-Resource-Policy: cross-origin` on public media, so a page that requires it (`Cross-Origin-Embedder-Policy`)
  can still embed it. Private media and download links don't set it.

Safe inline: `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/avif`, `video/*`, `audio/*`,
`application/pdf`, `text/plain`, `text/csv`, `application/json`, `text/vtt` and HLS playlists. Everything else is
sandboxed, including `text/html`, `image/svg+xml`, `application/xhtml+xml`, XML, `application/javascript` and unknown
types. HLS playlists and segments, captions, images, video, audio, PDFs and range requests are served as before, and
edge copies keep these headers. An `<img>` still shows an SVG, since images ignore both headers.

On the client, `<Preview>` and `useMediaObjectUrl` verify types themselves; see [Previewing private
files](media-references.md#previewing-private-files).

## Content verification

The declared `Content-Type` comes from the client, so the Worker also checks the bytes. Before it stores an upload, it
reads the first 4 KB of the plaintext (before encryption) and compares them with a signature table for the declared
type:

| Declared type | Expected bytes |
| --- | --- |
| `application/pdf` | `%PDF-` in the first 1024 bytes |
| `image/png`, `image/jpeg`, `image/gif`, `image/webp` | Their magic numbers |
| `image/avif`, `image/heic`, `image/heif` | An ISO-BMFF `ftyp` box with an AVIF or HEIF brand |
| `video/mp4`, `video/quicktime`, `video/x-m4v`, `audio/mp4`, `audio/x-m4a` | An ISO-BMFF `ftyp` box (or a classic QuickTime atom) |
| `video/webm`, `audio/webm`, `video/x-matroska` | EBML with a `webm` (or `matroska`) DocType |
| `audio/mpeg`, `audio/ogg`, `audio/wav`, `audio/flac` | ID3 or an MPEG frame sync, `OggS`, `RIFF…WAVE`, `fLaC` |
| `application/zip`, DOCX, XLSX, PPTX | A zip archive (`PK\x03\x04`) |
| `text/plain`, `text/csv`, `text/markdown` | Text: no NUL or other binary control bytes |
| `application/json` | UTF-8 text that starts with `{` or `[` (after a BOM and whitespace) |

**Markup** is what a browser would render as a document and run. A file counts as markup when:

- it starts (after a BOM and whitespace, in any case) with `<?xml`, `<svg`, `<!doctype html`, `<!--` or one of the
  WHATWG HTML-sniffing tags (`<html`, `<head`, `<script`, `<iframe`, `<h1`, `<div`, `<font`, `<table`, `<a`, `<style`,
  `<title`, `<b`, `<body`, `<br`, `<p`) followed by a space or `>`;
- a declared PDF has any of those before its `%PDF-` header;
- a declared PDF or text file has a distinct tag (`<script`, `<iframe`, `<html`, `<svg`, `<style`, …) followed by a
  space or `>` anywhere in its first 1024 bytes. Prose like "a <b then c" or "Use <bold>" isn't markup.

A type outside the table (`text/html`, `image/svg+xml`, `application/octet-stream`, …) isn't checked: it keeps its
declared type, and delivery sandboxes the risky ones.

The `contentSniffing` [rule](self-host.md#rules) picks what a mismatch gets:

| `contentSniffing` | Mismatch |
| --- | --- |
| `"scriptable"` (default) | `415 content_type_mismatch` when the bytes are markup; any other mismatch (a PNG that is a JPEG, an MP4 that is a WebM) is stored with its declared type |
| `"reject"` | `415 content_type_mismatch` for every mismatch |
| `"octet-stream"` | A single PUT is stored as `application/octet-stream` (delivered as a sandboxed attachment). A multipart upload is rejected. |
| `"off"` | Not checked |

```typescript
export default createWorker({ plugins: defaultPlugins({ contentSniffing: "reject" }) });
```

A rejected upload stores nothing and answers:

```json
{ "code": "content_type_mismatch", "declared": "application/pdf", "detected": "html", "error": "…" }
```

Every mismatch, whatever the mode does with it, is logged as one line you can search your Worker logs for:

```text
[content-sniff] {"declared":"image/png","detected":"jpeg","key":"public/image/…/photo.png","action":"accepted"}
```

`action` is `accepted`, `rejected` or `stored_as_octet_stream`. Before you switch to `reject` or `octet-stream`, check
the log for files you'd turn away. Real files the stricter modes reject or retype:

- images with the wrong extension (a JPEG saved as `.png`), and HEIC photos labelled `image/jpeg`;
- password-protected DOCX, XLSX and PPTX files, which are OLE containers rather than zip;
- PDFs whose `%PDF-` header comes after byte 1024;
- JSON that is a bare scalar (`"text"`, `42`) or UTF-16;

In every mode except `off`, a text file that starts with `<?xml` (an XML export saved as `.txt`) is markup and is
rejected.

A multipart upload's type is fixed when it starts, so the Worker checks every upload of part 1 when it arrives,
retries included. A rejected part 1 aborts the whole upload (the R2 session, its parts, the pending upload and its
encryption key). The Worker records the etag of the part 1 it checked, and `POST ?multipart=complete` answers
`409 content_unverified` unless the complete names that part 1. The SDKs send part 1 first, and `uploadMultipart`
makes up to 3 attempts at a complete that gets `content_unverified`, with a growing delay, since the record can take
a moment to reach every location.

A transcode's outputs (HLS playlists and segments, MP4 renditions, posters, storyboards) are never checked, as long as
the runner writes them with its own type for that folder (`application/vnd.apple.mpegurl` or `video/mp2t` under
`hls/`, `video/mp4` under `mp4/`, `image/jpeg` under `thumbnails/`, `image/jpeg` or `text/vtt` under `storyboard/`).
Any other type on those paths is checked like a client upload.

## Serve media from its own origin

The headers above keep an uploaded file from running script, and content verification keeps it from passing as another
type. The origin is the last line: serve media from a host of its own, never from your app's origin (a `/media/*`
route proxied on `app.example.com`). Anything that slips through then runs in the media origin, without your app's
cookies, storage or same-origin APIs.

When the media host is a subdomain of your app's domain (`media.example.com` next to `app.example.com`), the two are the
same site. Don't scope auth cookies to the parent domain (`Domain=example.com`): leave out `Domain` so each cookie stays
on the host that set it, and the media host never receives your users' sessions.

## Retention and holds

To keep a file from being deleted or overwritten (WORM), lock it with a compliance or governance retention, or a
hold. Deleting a locked file's encryption keys is refused too, since that destroys the file just the same. See
[Retention and holds](object-lock.md).
