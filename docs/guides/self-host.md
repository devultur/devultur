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

The Worker needs an R2 bucket bound as `MEDIA_BUCKET`, a second R2 bucket as `KEYS_BUCKET` (encryption keys), a KV
namespace as `MEDIA_KV` (pending uploads, transcode job state), the `DownloadLink` Durable Object (single-use download
links) and three secrets. The steps below set them up in order.

### Step by step

#### 1. Pick the account

If your login can see more than one Cloudflare account, non-interactive Wrangler commands fail with "More than one
account available but unable to select one in non-interactive mode". Pin the account before anything else, either in
`wrangler.toml`:

```toml
account_id = "<your-account-id>"
```

or in the environment, for CI and scripts:

```bash
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>
```

To check auth from a script, run `wrangler r2 bucket list`: it returns, and it proves both the login and R2 access.
Don't use `wrangler whoami` for that check: some versions print the account and then hang.

#### 2. Create the buckets

```bash
wrangler r2 bucket create media
wrangler r2 bucket create media-keys
```

`KEYS_BUCKET` holds the key of every file encrypted at rest ([L4 encryption](security.md#l4--encryption)). With
`security.encrypt` on, the Worker fails closed without it: a private upload, transcode or captions request answers
`503 keys_bucket_missing` and nothing is stored, instead of storing the file unencrypted. Keep it a separate
bucket, never public, and [back it up](#backing-up-keys_bucket): losing a key loses its file for good.

#### 3. Create the KV namespace

```bash
wrangler kv namespace create media-state
```

It prints a config snippet with the new namespace's `id`. Paste that id into the `MEDIA_KV` binding of
`wrangler.toml`. Running `create` again doesn't give you the id of a namespace that already exists: find it with
`wrangler kv namespace list`, which prints every namespace of the account with its `title` and `id`.

#### 4. Write `wrangler.toml`

Bind both buckets, the KV namespace and the `DownloadLink` Durable Object:

```toml
name = "media"
main = "src/index.ts"
compatibility_date = "2026-10-01"
account_id = "<your-account-id>"

[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "media"

# Per-object key material for encryption at rest. Required when `security.encrypt` is on.
[[r2_buckets]]
binding = "KEYS_BUCKET"
bucket_name = "media-keys"

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

Without the `DOWNLOAD_LINKS` binding, `POST /v1/token/download` answers `501`. For staging and production in one
file, see [Per-environment config](#per-environment-config).

#### 5. Set the secrets

The Worker requires all three secrets, even if you never transcode a video. Without them it fails closed: it doesn't
fall back to open access.

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
- **`TRANSCODE_WEBHOOK_SECRET`** signs the transcode callbacks (see [Transcode runners](#transcode-runners)).
  Without it, the Worker answers `503` to every callback, so no transcode ever completes: the first video upload
  would stay in progress for good. Set it even if you don't plan to transcode.

For captions, also set `GROQ_API_KEY` (transcription) and `MISTRAL_API_KEY` (translation) as secrets. Secrets are
per environment: with [environments](#per-environment-config), add `--env <name>` to each `wrangler secret put`.

#### 6. Deploy

```bash
wrangler deploy                    # with environments: wrangler deploy --env production
```

#### 7. Verify

```bash
curl https://media.example.com/health
curl https://media.example.com/v1/assets -H "Authorization: Bearer $WORKER_AUTH_SECRET"
```

`/health` is open. `GET /v1/assets` takes the Worker secret: it answers `401` with a wrong bearer, and
`503 worker_auth_secret_missing` if the secret didn't reach this environment. Then upload one file from your backend
and fetch it back.

### Per-environment config

Under `[env.<name>]`, Wrangler doesn't inherit `r2_buckets`, `kv_namespaces` or `durable_objects` from the top
level: repeat every binding in every environment, `KEYS_BUCKET` included. `migrations` stays top-level. Give each
environment its own buckets, KV namespace and secrets:

```toml
name = "media"
main = "src/index.ts"
compatibility_date = "2026-10-01"
account_id = "<your-account-id>"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["DownloadLink"]

# Staging
[env.staging]
name = "media-staging"

[[env.staging.r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "media-staging"

[[env.staging.r2_buckets]]
binding = "KEYS_BUCKET"
bucket_name = "media-keys-staging"

[[env.staging.kv_namespaces]]
binding = "MEDIA_KV"
id = "<staging-kv-namespace-id>"

[[env.staging.durable_objects.bindings]]
name = "DOWNLOAD_LINKS"
class_name = "DownloadLink"

# Production
[env.production]
name = "media-production"

[[env.production.r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "media-production"

[[env.production.r2_buckets]]
binding = "KEYS_BUCKET"
bucket_name = "media-keys-production"

[[env.production.kv_namespaces]]
binding = "MEDIA_KV"
id = "<production-kv-namespace-id>"

[[env.production.durable_objects.bindings]]
name = "DOWNLOAD_LINKS"
class_name = "DownloadLink"
```

`vars` aren't inherited either: repeat `[env.<name>.vars]` (for example `TRANSCODE_RUNNER`) in each one. Then set
the secrets and deploy per environment:

```bash
wrangler secret put WORKER_AUTH_SECRET --env staging
wrangler deploy --env staging
```

[Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/) lists what is and isn't
inherited.

### Backing up `KEYS_BUCKET`

R2 has no built-in backup, and losing a key loses its file for good: the encrypted bytes in `MEDIA_BUCKET` can't be
read without it. Copy `KEYS_BUCKET` to a bucket of its own, ideally in another account or with another provider:

- **A cron Worker** bound to `KEYS_BUCKET` and the backup bucket, which lists the keys bucket and copies each object
  the backup doesn't have yet. A key is written once and never changes, so copying the new ones is enough. Copy each
  object's `customMetadata` along with its body.
- **rclone** with [R2's S3 API](https://developers.cloudflare.com/r2/examples/rclone/), from a machine or a CI job on
  a schedule.

Each key lives at `{storageKey}/{keyId}`: the full storage key of its file plus a random id. To restore, copy the
objects back to the same keys, with their metadata. The Worker finds a file's key by that path, so a key restored
under another path is as good as lost. Give the backup the same access rules as the keys bucket: whoever holds both
the keys and the media can read your encrypted files.

### R2 bucket lock (defense in depth)

[Retention and holds](object-lock.md) are enforced by the Worker. An
[R2 bucket lock rule](https://developers.cloudflare.com/r2/buckets/bucket-locks/) adds a storage-level layer: R2
itself refuses overwrites and deletes of matching objects, also from the dashboard, `wrangler r2` or the S3 API.
Lock the same prefix in both buckets, so a file and its key are kept together:

```bash
# {root} is the Worker's storage prefix ("" if you don't set one)
wrangler r2 bucket lock add media records-retention "{root}private/asset/records/" --retention-days 3650
wrangler r2 bucket lock add media-keys records-retention "{root}private/asset/records/" --retention-days 3650
```

An asset is stored at `{root}{visibility}/asset/{path}` in `MEDIA_BUCKET`, and its key at
`{root}{visibility}/asset/{path}/{keyId}` in `KEYS_BUCKET`, so one prefix covers both. Use `--retention-days`,
`--retention-date` or `--retention-indefinite` to match the longest retention you set through the Worker.

> [!WARNING]
> Never lock `__lock/` or `__lock-audit/`, or a prefix that contains them, such as `""` or `{root}` alone. The Worker
> rewrites those records on every lock change, and a bucket lock on them makes lock changes and holds fail.

What changes once the rule is on:

- Nothing under the prefix can be deleted or replaced until its R2 retention ends, whatever the Worker's own lock
  says. That includes image variants (`{key}/__variants/…`) and the cleanup of `maxFileLifetimeSeconds`.
- **Racing duplicate uploads.** When two create-only uploads race for the same asset path, the loser deletes the
  key it made for its failed write. Under the lock R2 refuses that delete, so the loser gets a `500` instead of
  `409 already_exists`. Retry it: the retry sees the existing file and answers `409 already_exists`.
- **Don't trust `wrangler r2 object delete` to test the rule.** On a locked object it prints "Delete complete." and
  exits `0`, but the object stays. Check for the object afterwards instead:

  ```bash
  wrangler r2 object delete "media/private/asset/records/test.pdf" --remote
  wrangler r2 object get "media/private/asset/records/test.pdf" --remote --file check.pdf  # still there
  ```

Anyone who can edit the bucket's configuration can still remove the rule, so it raises the bar rather than closing
it.

### Calling the Worker

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
| `GET`/`PUT /v1/lock/<key>`, `POST /v1/lock/hold` | Worker secret ([Retention and holds](object-lock.md)) |
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
    security: { sessionBinding: true, ipBinding: false, encrypt: true }, // encrypt needs KEYS_BUCKET
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
| `maxFileLifetimeSeconds` | Longest lifetime of an uploaded file, in seconds: the default TTL and a ceiling (a shorter `expiresIn` still wins). For a demo or scratch Worker whose uploads clean themselves up. A [locked](object-lock.md#retention-vs-expiry) file still expires (viewers get `410`) but isn't deleted until its lock ends. |
| `uploadMetadata` | String map added to the R2 `customMetadata` of every uploaded object (for example which app uploaded it). Keys the Worker owns (`security`, `enc`, `expiresAt`, `derivedFrom`, `lock`, `sha256*`) are dropped. |
| `lock` | Default lock of an uploaded file: retention and hold (see [Retention and holds](object-lock.md)). An upload or its upload token overrides it. |
| `contentSniffing` | What an upload whose bytes contradict its declared type gets: `scriptable` (default: `415 content_type_mismatch` only for markup such as HTML or SVG under an inert type), `reject` (every mismatch), `octet-stream` or `off`. Every mismatch is logged as `[content-sniff] {…}`. See [Content verification](security.md#content-verification). |
| `transcode.presets` | Named presets and the default one, used when a request names no preset |
| `transcode.maxResolution` | Highest rung of the HLS ladder (`720p`, `1080p`, `4k`) |
| `transcode.deleteOriginalOnSuccess` | Delete the original once a transcode completes. It's never deleted after a failure, nor while it's [locked](object-lock.md#transcoding-a-locked-video). |
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

Set `TRANSCODE_WEBHOOK_SECRET` ([step 5](#5-set-the-secrets)) whatever runner you pick. The
script sends it on every callback, and the Worker rejects callbacks that don't carry it. If the
secret is unset, the Worker answers `503` to every callback.

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
