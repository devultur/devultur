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

Pass the policy to the Worker, and provision the keys bucket if you use `encrypt`:

```typescript
import { createWorker } from "@devultur/self-host";

export default createWorker({
  config: { security: { sessionBinding: true, ipBinding: false, encrypt: true } },
});
```

```toml
# wrangler.toml
[[r2_buckets]]
binding = "KEYS_BUCKET"
bucket_name = "devultur-media-keys"
```

Per-resource overrides travel in the object metadata (set on upload, read on delivery) and resolve
against the Worker default — exactly like `visibility`.
