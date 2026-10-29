---
"@devultur/convex": minor
---

Apply the Worker's media lifecycle webhooks to the component's records.

- The `/webhook` route also accepts signed requests, verified with the new optional `DEVULTUR_WEBHOOK_SECRET` env
  var (several space-separated during a rotation). The `DEVULTUR_SECRET` bearer keeps working for transcode and
  captions events.
- `media.deleted` removes the record and its captions; `media.changed` sets the record's new `lock`, `etag` and
  `originalDeleted` fields. Each event is applied once (a new `processedEvents` table, pruned after 7 days by an hourly
  cron) and only when it's newer than the last one applied to the record and than the record itself.
- `registerDevulturWebhook(http, components.devultur, { path, signingSecret?, onMediaDeleted?, onMediaChanged? })`
  registers the route in your app: it applies each event to the component, then runs your internal mutation; the event
  counts as handled only once that returns, so a failure or a crash in between is retried.
  `mediaDeletedEventValidator` and `mediaChangedEventValidator` validate its `{ event }`.
- `devultur.missingKeys(ctx, keys)` returns the media ids with no record, to find dangling references.
