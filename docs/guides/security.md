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
- For any type outside the safe-inline list, also `Content-Security-Policy: sandbox` (no script, an opaque origin)
  and `Content-Disposition: attachment` (opening it downloads it; a stored filename is kept).

Safe inline: `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/avif`, `video/*`, `audio/*`,
`application/pdf`, `text/plain`, `text/csv`, `application/json`, `text/vtt` and HLS playlists. Everything else is
sandboxed, including `text/html`, `image/svg+xml`, `application/xhtml+xml`, XML, `application/javascript` and unknown
types. HLS playlists and segments, captions, images, video, audio, PDFs and range requests are served as before, and
edge copies keep these headers. An `<img>` still shows an SVG, since images ignore both headers.

On the client, `<Preview>` and `useMediaObjectUrl` verify types themselves; see [Previewing private
files](media-references.md#previewing-private-files).

## Retention and holds

To keep a file from being deleted or overwritten (WORM), lock it with a compliance or governance retention, or a
hold. Deleting a locked file's encryption keys is refused too, since that destroys the file just the same. See
[Retention and holds](object-lock.md).
