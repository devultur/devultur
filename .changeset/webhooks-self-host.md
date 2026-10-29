---
"@devultur/self-host": minor
---

Send signed media lifecycle webhooks.

- `media.deleted` from `DELETE /v1/media/videos/:id` and `DELETE /v1/media/:key` when something was deleted (none
  when a lock refuses it), and `media.changed` for lock and hold changes, overwritten originals (`replaced`) and
  originals deleted after a transcode or by key (`original-deleted`).
- Configured with `config.webhooks` (`url`, `secret`, `events`), per scope through the request state, or the
  `MEDIA_WEBHOOK_URL` / `MEDIA_WEBHOOK_SECRET` variables. Signed with Standard Webhooks headers; several secrets
  during a rotation. Only `https` URLs on public hosts, unless `allowUnsafeUrl` is set for local development.
- With a `WEBHOOK_QUEUE` binding and the exported `deliverWebhooks` consumer, failures are retried after 30 s, 2 min,
  10 min, 1 h and then 6 h, up to 8 attempts, then sent to the dead-letter queue. Without one, a single attempt after
  the response. Each attempt is logged in `MEDIA_KV` at `webhook-delivery:{id}` for 7 days.
- `onMediaEvent` plugin hook: when a plugin provides it, it gets the events and the built-in delivery is skipped.
- `deletePrefixRespectingLocks` takes `onDeleted`; `mediaDeletedEvents` and `sendMediaEvents` turn its report into
  one `media.deleted` per media and send them.
- Transcode and captions events can also go to the webhook, opted in through `events`.
