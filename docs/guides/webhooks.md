# Media webhooks

The media Worker tells your backend when stored media changes outside your own calls: a file deleted, a video's
original deleted after its transcode, a lock or hold changed, a file replaced. Keep your media records in step with
these events instead of finding dangling references later.

Events are signed with [Standard Webhooks](https://www.standardwebhooks.com), so any of its libraries can verify
them, and so can `verifyWebhookSignature` from `@devultur/core`.

## Events

Every event has the same envelope:

```json
{
  "id": "evt_6f1c0b0e-3c9a-4a43-9a43-2b9b8f0f6a51",
  "type": "media.deleted",
  "occurredAt": "2026-11-03T14:05:09.120Z",
  "apiVersion": 1,
  "data": { "...": "..." }
}
```

### `media.deleted`

```json
{
  "key": "private/video/0b6c…",
  "mediaId": "0b6c…",
  "kind": "video",
  "visibility": "private",
  "reason": "api"
}
```

| Field | Meaning |
| --- | --- |
| `key` | What was deleted: the object's key, or a video's folder (`{visibility}/video/{id}`). A whole video is one event. |
| `mediaId` | The media id (`DevulturMedia.id`). For a file under `asset/`, its key. |
| `kind` | `image`, `video`, `file` or `asset`. |
| `reason` | `api` (`DELETE /v1/media/…`). From your Worker's own code (a prefix delete), the reason it passes: `prefix`, `purge`, `expired` or `raw-retention`. |
| `retainedCount` | Present when part of the media was kept because it's locked. |

A delete that a lock refuses, or that found nothing, sends nothing. Deleting one output of a video (a playlist, a
caption) is no event; deleting its original by key is a `media.changed` with `original-deleted`.

### `media.changed`

```json
{
  "key": "public/image/9a1e…/photo.jpg",
  "mediaId": "9a1e…",
  "changes": ["hold"],
  "lock": { "hold": true },
  "etag": "a3f9…"
}
```

| `changes` entry | When |
| --- | --- |
| `lock` | `PUT /v1/lock/:key` changed the retention. `lock` is the lock after it. |
| `hold` | `POST /v1/lock/hold` set or released a hold, one event per object it changed. `lock` is the lock after it. |
| `replaced` | An upload overwrote an original (an image, a file, an asset, a video's original). `etag` is the new object's. A transcode's outputs never count. |
| `original-deleted` | A video's original was deleted (after its transcode with `transcode.deleteOriginalOnSuccess`, or by key). Its outputs stay. `etag` is the deleted original's. |

Metadata and visibility changes aren't events.

### Transcode and captions events

List their types in `events` (for example `transcode.complete`, `captions.failed`) and they come to the same
endpoint, in the same envelope, with `data` set to the event a job's `callbackUrl` receives. They are sent in addition
to the `callbackUrl`, not instead of it.

## Delivery guarantees

Delivery is at least once and unordered. A receiver:

- deduplicates by `id`: a retry sends the same event again with the same `id`;
- applies an event only when its `occurredAt` is newer than the last event it applied to that media (`isNewerEvent`
  from `@devultur/core`), and treats a different `etag` as another version of the object;
- treats `media.deleted` as final, unless a later `media.changed` with `replaced` arrives (the key was written
  again).

Answer `2xx` quickly and do the work afterwards. Any other answer, a timeout (15 seconds) or a redirect counts as a
failure.

## Verifying a webhook

Each request carries three headers:

| Header | Value |
| --- | --- |
| `webhook-id` | The event's `id`. |
| `webhook-timestamp` | Unix seconds when this attempt was signed. |
| `webhook-signature` | `v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{body}">`, several space-separated during a rotation. |

Verify against the raw body, before parsing it:

```typescript
import { verifyWebhookSignature } from "@devultur/core";

export async function POST(request: Request) {
  const body = await request.text();
  const verification = await verifyWebhookSignature({
    payload: body,
    headers: request.headers,
    secret: process.env.MEDIA_WEBHOOK_SECRET!,
  });
  if (!verification.ok) return new Response("Unauthorized", { status: 401 });
  const event = JSON.parse(body);
  // Deduplicate by event.id, then apply it.
  return new Response(null, { status: 204 });
}
```

`verifyWebhookSignature` refuses a timestamp more than five minutes from the receiver's clock (`toleranceSeconds`
changes it) and compares signatures in constant time. With `@devultur/server`, `router.handleWebhook(body, {
signingSecret, headers })` does the same and returns the event. The Convex component verifies them on its
`/webhook` route (see its README).

The secret is either `whsec_` followed by base64 (the Standard Webhooks format; the key is the decoded bytes) or any
other string (the key is its UTF-8 bytes). Generate one with:

```bash
echo "whsec_$(openssl rand -base64 32)"
```

### Rotating the secret

1. Give the receiver both secrets (`secret: [oldSecret, newSecret]`).
2. Give the Worker both (`MEDIA_WEBHOOK_SECRET="<old> <new>"`, or `secret: [old, new]` in `config.webhooks`): each
   request is signed with both.
3. Remove the old secret from the Worker, then from the receiver.

## Configuring the Worker

Set the endpoint and its secret as variables:

```bash
wrangler secret put MEDIA_WEBHOOK_SECRET   # whsec_… (two space-separated during a rotation)
```

```toml
[vars]
MEDIA_WEBHOOK_URL = "https://api.example.com/media-webhooks"
# MEDIA_WEBHOOK_EVENTS = "media.deleted,media.changed,transcode.complete"
```

Or in the config, where a plugin can also set it per scope through the request state (`updateRequestState(context, {
config: { webhooks } })`):

```typescript
import { createWorker, defaultPlugins } from "@devultur/self-host";

export default createWorker({
  plugins: defaultPlugins({
    webhooks: {
      url: "https://api.example.com/media-webhooks",
      secret: "whsec_…",
      events: ["media.deleted", "media.changed", "transcode.complete"],
    },
  }),
});
```

| `webhooks` field | What it does |
| --- | --- |
| `url` | Where events go. It must be `https` on a public host: `http`, `localhost`, private, link-local and loopback addresses are refused (the event is logged and dropped), and redirects aren't followed. |
| `secret` | Signing secret, or several during a rotation. |
| `events` | Types sent. Default `media.deleted` and `media.changed`. |
| `allowUnsafeUrl` | Allows `http` and private hosts, for local development only (`MEDIA_WEBHOOK_ALLOW_UNSAFE_URL=true` with the variables). |

A transcode keeps the webhook of the scope that launched it: its `original-deleted` and `transcode.*` events go there,
even though the runner's callbacks carry no scope.

### Retries with a queue

Without a queue, each event gets one attempt after the response. Bind a queue to retry failures:

```toml
[[queues.producers]]
binding = "WEBHOOK_QUEUE"
queue = "media-webhooks"

[[queues.consumers]]
queue = "media-webhooks"
max_retries = 7
dead_letter_queue = "media-webhooks-dlq"
```

```typescript
import { createWorker, deliverWebhooks } from "@devultur/self-host";

const app = createWorker();
export default { fetch: app.fetch, queue: deliverWebhooks };
```

A failed attempt is retried after 30 seconds, 2 minutes, 10 minutes, 1 hour, then every 6 hours: 8 attempts in all,
over about 19 hours. After the last one the event goes to the dead-letter queue: the queue's own `dead_letter_queue` (keep
`max_retries = 7`), or a `WEBHOOK_DLQ` producer binding when you bind one. Each attempt is signed again, so a late
retry still passes the receiver's timestamp check. Queue messages carry the target's URL and secrets, since a retry
needs them to sign.

### Delivery log

Each event's last attempt is recorded in `MEDIA_KV` at `webhook-delivery:{eventId}` for 7 days: `status`
(`delivered`, `retrying`, `failed` or `dead-lettered`), `attempts`, the last `responseStatus` and `error`.
`readDeliveryRecord(env.MEDIA_KV, eventId)` reads it.

## Delivering events your own way

A plugin with `onMediaEvent` gets every `media.*` event (and the `transcode.*` and `captions.*` types the scope's
`events` lists) after the response. While any plugin has one, the Worker's own delivery is skipped: no request, no
queue message, no delivery log.

```typescript
const eventsToQueue: WorkerPlugin = {
  name: "events-to-queue",
  onMediaEvent: async (context, event) => {
    await context.env.EVENTS.send({ scope: getRequestState(context).storagePrefix, event });
  },
};
```

On a runner callback (`original-deleted` after a transcode) the request has no scope of its own:
`getRouteResult(context).transcodeJob?.context` is the plugin context of the request that launched the job.

## Deleting a prefix from your own code

`deletePrefixRespectingLocks` sends nothing by itself. Its `onDeleted` gets what each call deleted; turn that into one
`media.deleted` per media with `mediaDeletedEvents` and send them with `sendMediaEvents`:

```typescript
import { deletePrefixRespectingLocks, mediaDeletedEvents, sendMediaEvents } from "@devultur/self-host";

const result = await deletePrefixRespectingLocks({
  mediaBucket: env.MEDIA_BUCKET,
  keysBucket: env.KEYS_BUCKET,
  prefix: "apps/a1/",
  onDeleted: (deleted) => sendMediaEvents(env, mediaDeletedEvents(deleted, { reason: "purge" })),
});
```

A media whose files were all kept gets no event, nor does a video whose outputs were deleted while its locked
original stayed. A media gets its event from the call that deletes its original. To fill `retainedCount`, build the
events after the call instead, from everything `onDeleted` collected and `retained: result.retained`.
