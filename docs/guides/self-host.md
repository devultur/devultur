# Self-host (bring your own R2)

Run the Devultur media Worker and SDKs against your own Cloudflare account and R2 bucket.

There are two ways to use Devultur on your own infrastructure:

- **Media Worker** (recommended): deploy `@devultur/self-host` on your Cloudflare account. It handles uploads,
  delivery, transcode, captions and image transforms, and your backend talks to it with `@devultur/server`.
- **Direct R2**: point `@devultur/server` at your R2 bucket with S3 credentials and sign delivery yourself, with
  no Worker in between.

## Direct R2

The server SDK presigns uploads straight to your bucket and signs delivery URLs:

```typescript
import { createMediaRouter, video, image, file } from "@devultur/server";

export const media = createMediaRouter({
  storage: {
    provider: "r2",
    bucket: "my-media",
    accountId: process.env.CF_ACCOUNT_ID!,
    accessKeyId: process.env.R2_ACCESS_KEY!,
    secretAccessKey: process.env.R2_SECRET_KEY!,
  },
  delivery: {
    signSecret: process.env.DELIVERY_SIGN_SECRET!,
  },
  video: video({ maxSize: "2GB" }),
  image: image({ maxSize: "10MB" }),
  file: file({ maxSize: "500MB" }),
});
```

> [!NOTE]
> The Worker honors the `preset` you pass, so transcode resolution is yours to control. Cap it with
> `config.transcode.maxResolution` (see below).

## The media Worker

To run uploads, delivery, transcode and captions on your own Cloudflare account, deploy the
media Worker from `@devultur/self-host`:

```typescript
import { createWorker } from "@devultur/self-host";
export { DownloadLink } from "@devultur/self-host";

export default createWorker();
```

Bind an R2 bucket as `MEDIA_BUCKET`, a KV namespace as `MEDIA_KV` (pending uploads, transcode job
state) and the `DownloadLink` Durable Object (single-use download links) in `wrangler.toml`:

```toml
name = "media"
main = "src/index.ts"
compatibility_date = "2026-10-01"

[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "media"

[[kv_namespaces]]
binding = "MEDIA_KV"
id = "<kv-namespace-id>"

[[durable_objects.bindings]]
name = "DOWNLOAD_LINKS"
class_name = "DownloadLink"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["DownloadLink"]
```

Without the `DOWNLOAD_LINKS` binding, `POST /v1/token/download` answers `501`. For captions, also set
`GROQ_API_KEY` (transcription) and `MISTRAL_API_KEY` (translation) as secrets.

The Worker requires three secrets. Without them it fails closed: it doesn't fall back to open access.

```bash
wrangler secret put DELIVERY_SIGN_SECRET        # openssl rand -base64 32
wrangler secret put WORKER_AUTH_SECRET          # openssl rand -base64 32
wrangler secret put TRANSCODE_WEBHOOK_SECRET    # openssl rand -base64 32
```

- **`DELIVERY_SIGN_SECRET`** signs viewer tokens, download links and transcode job tickets. Without it,
  issuing or verifying them fails with `500`.
- **`WORKER_AUTH_SECRET`** is your backend's credential. Every control route requires
  `Authorization: Bearer <WORKER_AUTH_SECRET>`. Without the secret, those routes answer
  `503 worker_auth_secret_missing`. With a missing or wrong bearer, they answer `401`. The transcode
  runner also uploads its renditions with this secret, and a job's `callbackUrl` receives it as its bearer (the
  Convex component checks it against `DEVULTUR_SECRET`).
- **`TRANSCODE_WEBHOOK_SECRET`** signs the transcode callbacks (see below). Without it, the Worker
  answers `503` to every callback.

Your backend calls the Worker with the server SDK. Pass the Worker URL as `baseUrl` and the
secret as `secret`. Never ship the secret to the browser.

```typescript
import { createMediaRouter } from "@devultur/server";

export const media = createMediaRouter({
  baseUrl: "https://media.example.com",
  secret: process.env.WORKER_AUTH_SECRET!,
});
```

| Route | Access |
| --- | --- |
| `POST /v1/upload` | Worker secret, or an upload token from `POST /v1/token/upload` (only inside its prefix) |
| `PUT`, `POST`, `DELETE /v1/upload/<key>?u=<id>` | The URL that `POST /v1/upload` returned is the credential: its random `u` id names the upload, and a missing or wrong id gets `404`. Without that URL, only the Worker secret can write. |
| `DELETE /v1/media/…`, `GET /v1/assets` | Worker secret |
| `/v1/transcode`, `/v1/captions` | Worker secret |
| `POST /v1/token`, `/v1/token/upload`, `/v1/token/download` | Worker secret |
| `GET`/`HEAD /v1/media/…` | Public media is open. Private media needs a viewer token from `POST /v1/token`, or the Worker secret. |
| `GET /v1/download/<id>` | The link id is the credential (single use) |
| `POST /v1/webhooks/transcode` | `TRANSCODE_WEBHOOK_SECRET` |
| `GET /health`, `POST /v1/metrics/playback` | Open |

The browser never talks to a control route. It uploads to the URL your backend got from
`POST /v1/upload`, and plays private media with a viewer token your backend issued.

> [!WARNING]
> The Worker secret check is the `workerSecretAuth()` plugin. To authenticate with your own credentials, replace it
> with an auth plugin of yours (see [Plugins](plugins.md)): `createWorker()` refuses to start without one.

## Rules

`createWorker()` runs the [default plugins](plugins.md#default-plugins). Pass the rules every request follows to
`defaultPlugins(config)`:

```typescript
import { createWorker, defaultPlugins } from "@devultur/self-host";

export default createWorker({
  plugins: defaultPlugins({
    security: { sessionBinding: true, ipBinding: false, encrypt: false },
    uploadRules: { image: { maxSizeBytes: 10_000_000, accept: ["image/*"] } },
    captionsLocales: ["en", "es"],
    transcode: { maxResolution: "1080p", deleteOriginalOnSuccess: true },
  }),
});
```

| `config` field | What it does |
| --- | --- |
| `security` | Default security policy: session and IP binding, encryption at rest |
| `uploadRules` | Per media type (`video`, `image`, `file`): `maxSizeBytes`, `accept` and default `visibility` |
| `captionsLocales` | Locales `/v1/captions` accepts (unset: any) |
| `cacheRules` | `Cache-Control` per prefix of the `asset/` namespace |
| `originalStorageClass` | R2 storage class of an uploaded video original (`Standard` or `InfrequentAccess`) |
| `maxFileLifetimeSeconds` | Longest lifetime of an uploaded file, in seconds: the default TTL and a ceiling (a shorter `expiresIn` still wins). For a demo or scratch Worker whose uploads clean themselves up. |
| `uploadMetadata` | String map added to the R2 `customMetadata` of every uploaded object (for example which app uploaded it). Keys the Worker owns (`security`, `enc`, `expiresAt`, `derivedFrom`, `sha256*`) are dropped. |
| `transcode.presets` | Named presets and the default one, used when a request names no preset |
| `transcode.maxResolution` | Highest rung of the HLS ladder (`720p`, `1080p`, `4k`) |
| `transcode.deleteOriginalOnSuccess` | Delete the original once a transcode completes. It's never deleted after a failure. |
| `transcode.outputBaseUrl` | Base of the output URLs in your webhook. Unset: the origin of the transcode request. |

A plugin can narrow these rules per request, for example to give each of your apps its own storage prefix,
upload rules and credentials. [Plugins](plugins.md) covers the request state, the hooks before a credential is
issued or a download link is redeemed, and three example plugins: JWT auth, a usage log and rate limiting.

## Transcode runners

The self-host media Worker doesn't run FFmpeg itself. It generates a shell script for each
video and hands it to a **runner**. The runner starts that script inside the transcode image
(`infra/transcode/Dockerfile`, Alpine + FFmpeg + curl). The script downloads the raw video from
your Worker, encodes the HLS ladder, uploads the renditions back, and reports progress through
signed webhooks to `/v1/webhooks/transcode`. Every runner uses the same script, and job status
always comes from those webhooks, never from the provider.

Pick the runner with the `TRANSCODE_RUNNER` var:

| Runner | `TRANSCODE_RUNNER` | Best for | Needs |
| --- | --- | --- | --- |
| Cloudflare Containers | `cloudflare` (default when unset) | **Recommended.** Same deploy and account as the Worker | Workers Paid plan, Docker where you run `wrangler deploy` |
| Fly Machines | `fly` | An existing Fly setup | A Fly app, an API token, a pushed image |
| HTTP | `http` | A VPS or your own queue | A host running the reference runner behind HTTPS |

Set `TRANSCODE_WEBHOOK_SECRET` (`openssl rand -base64 32`) whatever runner you pick. The
script sends it on every callback, and the Worker rejects callbacks that don't carry it. If the
secret is unset, the Worker rejects every callback.

### Cloudflare Containers (recommended)

Each video gets its own Durable Object, and that Durable Object starts one container with
the transcode image. Wrangler builds and pushes the image on `wrangler deploy`.

1. Re-export the container class from your Worker entry:

   ```typescript
   import { createWorker } from "@devultur/self-host";
   export { TranscodeContainer } from "@devultur/self-host/transcode-container";

   export default createWorker();
   ```

2. Add the container, the binding and the var to `wrangler.toml` (full snippet in
   `infra/transcode/wrangler.containers.example.toml`):

   ```toml
   [vars]
   TRANSCODE_RUNNER = "cloudflare"
   # CF_TRANSCODE_INSTANCE = "standard-4"   # default: 4 vCPU, 12 GiB, 20 GB disk

   [[containers]]
   class_name = "TranscodeContainer"
   scheduling_policy = "durable_object"

   [containers.images.transcode]
   dockerfile = "../../infra/transcode/Dockerfile"

   [[durable_objects.bindings]]
   name = "TRANSCODE_CONTAINER"
   class_name = "TranscodeContainer"

   [exports.TranscodeContainer]
   type = "durable-object"
   storage = "sqlite"
   ```

3. Run `wrangler deploy` with a recent Wrangler (4.150 accepts `scheduling_policy = "durable_object"`, `images` and `exports`; 4.103 rejects them).

> [!WARNING]
> The instance disk has to hold the raw upload plus every rendition. On `standard-4` that's
> 20 GB, so a very long 4K source may not fit. If a container dies without running the
> script's failure trap (out of memory, host restart), its Durable Object reports
> `transcode.failed` for it.

### Fly Machines

Each job runs on a fresh Fly Machine that destroys itself when the job ends. Creating a
machine is retried on 429/5xx with exponential backoff, because the Machines API allows 1
create per second.

```bash
fly apps create my-transcode
cd infra/transcode && fly deploy --ha=false   # note the image tag it prints
wrangler secret put FLY_API_TOKEN
```

| Var | Default | |
| --- | --- | --- |
| `FLY_APP_NAME` | — | Fly app that runs the machines |
| `FLY_TRANSCODE_IMAGE` | — | `registry.fly.io/<app>:<tag>` |
| `FLY_API_TOKEN` | — | Secret |
| `FLY_TRANSCODE_CPU_KIND` | `performance` | Avoid `shared`: FFmpeg gets throttled to its 6.25% CPU baseline |
| `FLY_TRANSCODE_CPUS` | `4` | |
| `FLY_TRANSCODE_MEMORY_MB` | `8192` | |
| `FLY_REGION` | — | Region of the machines (`iad`, `fra`, …). Unset: Fly picks one. |

### HTTP (VPS or your own queue)

The Worker POSTs each job to `TRANSCODE_RUNNER_URL` with `Authorization: Bearer <TRANSCODE_RUNNER_SECRET>`:

```json
{
  "version": 1,
  "videoId": "abc123",
  "command": ["sh", "-c", "echo \"$TRANSCODE_SCRIPT_B64\" | base64 -d | sh"],
  "env": { "TRANSCODE_SCRIPT_B64": "…", "WORKER_URL": "…", "CALLBACK_URL": "…" }
}
```

Your runner runs `command` with `env` in the transcode image and answers `2xx`, optionally
with `{ "jobId": "…" }`. The Worker retries 429/5xx responses with backoff. The reference
runner `infra/transcode/http-runner/server.ts` (Node 22.18+, no dependencies) queues jobs
and runs each one with `docker run`:

```bash
docker build -t devultur-ffmpeg infra/transcode
RUNNER_SECRET=$(openssl rand -base64 32) MAX_CONCURRENT_JOBS=2 \
  node infra/transcode/http-runner/server.ts
```

Then set `TRANSCODE_RUNNER = "http"` and `TRANSCODE_RUNNER_URL = "https://runner.example.com/jobs"`
on the Worker, plus `wrangler secret put TRANSCODE_RUNNER_SECRET`. Optionally set
`TRANSCODE_RUNNER_CPUS` to the cores per job, which feeds the encode measurement.

> [!CAUTION]
> The job `env` carries the runner's upload credential and the callback secret. Only expose the
> runner over HTTPS, for example behind Caddy or a Cloudflare Tunnel.

### Measuring encode cost

Every `transcode.complete` the runner sends carries an `encode` measurement, for you as the operator: `seconds`
(FFmpeg wall-clock time), `cpus`, `runner` and `topRung` (the highest rendition), plus the per-title `complexity`,
`probeSeconds` and `params`. The Worker logs it as `[transcode-metrics] {…"vcpuSecondsPerVideoMinute":…}` (vCPU
seconds per minute of video, to size and compare runners), and a plugin can read it with `parseEncodeMetrics`.
Your app's webhook doesn't get it.

For presets, templates and inline specs, each entry of `renditions` in the webhook carries the output's real
`width` and `height` in pixels (an HLS ladder by its top rung), measured on the encoded file.

## Image transforms

Image transforms (`?w=`, `?h=`, `?fit=`, `?format=`, `?q=`) run inside the media Worker with WebAssembly
codecs. Each unique transform is computed once and stored in your bucket next to the original
(`{key}/__variants/…`), so later requests are served like any other object, with `Range` support and
the edge cache.

- **Large originals.** The Worker decodes images up to 4 megapixels (`IMAGE_TRANSFORMS_MAX_MEGAPIXELS`).
  For a larger original, the first transform asks Cloudflare Images for one downscaled master and stores
  it next to the original. Every later variant is built from that master in the Worker.
- **Cloudflare Images fallback.** GIFs, animated images, sizes that need more pixels than the master
  has, and any codec failure go to Cloudflare Images for that request. Image Transformations must be
  enabled on the zone that serves the Worker.
- **`fit=fill`** stretches to the exact `w`×`h`, ignoring the aspect ratio.
- **`format=auto`** is negotiated from the `Accept` header: AVIF for outputs up to about 1 megapixel, then
  WebP, then JPEG (PNG for PNG originals). Responses carry `Vary: Accept`.
- **Private and encrypted images.** Variants of a private image stay private. If the original is
  encrypted at rest, its variants are encrypted too, each with its own key.
- **Deleting** an original also deletes its variants and their keys.

Set `IMAGE_TRANSFORMS = "cloudflare"` to send every transform to Cloudflare Images instead.
