---
"@devultur/convex": minor
---

Apply the Worker's media lifecycle webhooks to the component's records.

- The `/webhook` route also accepts signed requests, verified with the new optional `DEVULTUR_WEBHOOK_SECRET` env
  var (several space-separated during a rotation). The `DEVULTUR_SECRET` bearer keeps working for transcode and
  captions events.
- `media.deleted` removes the record and its captions; `media.changed` sets the record's new `lock`, `etag` and
  `originalDeleted` fields. Each event is applied once (a new `processedEvents` table, kept 7 days) and only when it's
  newer than the last one applied to the record.
- `registerDevulturWebhook(http, components.devultur, { path, signingSecret?, onMediaDeleted?, onMediaChanged? })`
  registers the route in your app: it applies each event to the component, then runs your internal mutation once.
  `mediaDeletedEventValidator` and `mediaChangedEventValidator` validate its `{ event }`.
- `devultur.missingKeys(ctx, keys)` returns the media ids with no record, to find dangling references.
