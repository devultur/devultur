---
"@devultur/core": minor
---

Add media lifecycle webhook events and Standard Webhooks signatures.

- `media.deleted` and `media.changed` events in one envelope (`{ id, type, occurredAt, apiVersion, data }`), with
  `createWebhookEvent`, `isWebhookEvent`, `isMediaLifecycleEvent` and `isNewerEvent`. Delivery is at least once and
  unordered: deduplicate by `id` and apply an event only when its `occurredAt` is newer.
- `signWebhook` and `verifyWebhookSignature`: `webhook-id`, `webhook-timestamp` and `webhook-signature` headers,
  HMAC-SHA256, several signatures during a secret rotation, a timestamp tolerance and a constant-time compare.
- `WebhookVerifyOptions` takes `signingSecret` and `headers`: `router.handleWebhook` verifies a signed request and
  returns its envelope. A request with `Authorization: Bearer <secret>` is accepted as before.
- `handleWebhook` applies `media.deleted` (through a new `remove` callback) and `media.changed` (the `lock` and
  `etag`), ignoring an event older than the last one applied, and unwraps transcode and captions events sent in the
  envelope.
