# @devultur/convex

[Convex](https://convex.dev) component for Devultur media: stores media records and watch progress in isolated
tables, exposes upload, token, transcode and delete functions for your app, serves the transcode webhook route, and
ships typed validators and React bindings.

## Install

```bash
pnpm add @devultur/convex
pnpm exec devultur-init
```

`devultur-init` adds the component to `convex/convex.config.ts` (mounted with `httpPrefix: "/devultur/"`, see
[Webhook route](#webhook-route)), creates `convex/devultur.ts` with the exposed functions, and prints the Convex env
vars to set (your media Worker's URL and credential).

## Webhook route

The component receives transcode and captions events on its own HTTP route, `POST /webhook`. Convex serves a
component's HTTP routes only when the app mounts the component with an `httpPrefix`:

```typescript
// convex/convex.config.ts
app.use(devultur, { httpPrefix: "/devultur/", env: { /* see below */ } });
```

With that prefix the route is `https://<deployment>.convex.site/devultur/webhook`. You don't need an `http.ts` entry
for it. `processVideo` sends the Worker that URL as the `callbackUrl`, and it follows the prefix you choose (with
`httpPrefix: "/media/"` it is `https://<deployment>.convex.site/media/webhook`).

Without `httpPrefix` the route doesn't exist: the Worker's events get `404`, the media record never leaves
`queued`, and every transcode fails with a timeout.

## Example

```typescript
// convex/schema.ts
import { dv } from "@devultur/convex";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  courses: defineTable({
    title: v.string(),
    thumbnail: dv.media("image").optional(), // a typed media reference, not a URL
  }),
});
```

```tsx
// React
import { DevulturProvider, Image, useDevultur } from "@devultur/convex/react";
import { api } from "../convex/_generated/api";

<DevulturProvider api={api.devultur}>
  <App />
</DevulturProvider>;

function CourseCover({ course }) {
  return <Image media={course.thumbnail} alt={course.title} width={512} format="webp" />;
}

function CoverUpload({ onSaved }) {
  const { upload } = useDevultur();
  return <input type="file" onChange={async (event) => onSaved(await upload(event.target.files![0]))} />;
}
```

## Using a self-hosted Worker

The component talks to any Worker built with `createWorker()` from
[`@devultur/self-host`](https://github.com/devultur/devultur/tree/main/packages/self-host) (see the
[self-host guide](https://github.com/devultur/devultur/blob/main/docs/guides/self-host.md)). It needs two values:

| Convex env var | Value |
| --- | --- |
| `DEVULTUR_API_URL` | The Worker's origin, without a trailing slash, for example `https://media.example.com` |
| `DEVULTUR_SECRET` | The Worker's `WORKER_AUTH_SECRET`, the same string you set with `wrangler secret put` |

Declare both in your app and bind them to the component. Convex rejects `app.env.<NAME>` for a name that
`defineApp()` doesn't declare:

```typescript
// convex/convex.config.ts
import devultur from "@devultur/convex/convex.config";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({ env: { DEVULTUR_SECRET: v.string(), DEVULTUR_API_URL: v.string() } });
app.use(devultur, {
  httpPrefix: "/devultur/",
  env: { DEVULTUR_SECRET: app.env.DEVULTUR_SECRET, DEVULTUR_API_URL: app.env.DEVULTUR_API_URL },
});

export default app;
```

```bash
npx convex env set DEVULTUR_API_URL https://media.example.com
npx convex env set DEVULTUR_SECRET <the Worker's WORKER_AUTH_SECRET>
```

**Webhooks.** Keep the `httpPrefix` in `app.use()`: without it Convex doesn't serve the component's route and every
transcode times out (see [Webhook route](#webhook-route)). Nothing else needs configuring. `processVideo` sends the
Worker a `callbackUrl` that points at the component's route, `https://<deployment>.convex.site/devultur/webhook`
(your app's `CONVEX_SITE_URL` followed by the prefix and `webhook`). The transcode runner reports to the Worker with
`TRANSCODE_WEBHOOK_SECRET`. The Worker then forwards each event to the `callbackUrl` with
`Authorization: Bearer <WORKER_AUTH_SECRET>`. The component accepts an event only when that bearer equals
`DEVULTUR_SECRET`. If `DEVULTUR_SECRET` is wrong or missing, the component answers `401` to every event. Keep
`TRANSCODE_WEBHOOK_SECRET` on the Worker only: the component never needs it.

If you replace the Worker's `workerSecretAuth()` plugin with an auth plugin of your own, the Worker forwards
webhooks with the `webhookCredential` your plugin sets in the request state (or `runnerCredential` when it sets
none; see [Plugins](https://github.com/devultur/devultur/blob/main/docs/guides/plugins.md)). Set `DEVULTUR_SECRET`
to that value, and make sure your plugin also accepts it as the bearer of the component's calls.

## Errors

When the media Worker refuses a request, component actions throw a `ConvexError` whose `data` is
`{ code, message, status, details? }`. A plain `Error` would lose these fields across the component boundary. `code` is
the Worker's stable code: for example `retention_active`, `compliance_extend_only`, `lock_conflict`,
`lock_privilege_required`, `file_too_large`, or `worker_error` when the Worker sent none. `details` carries the rest of
the Worker's answer, such as the `{ key, mode, until, hold }` of a `retention_active`.

```ts
import { devulturErrorOf } from "@devultur/convex";

try {
  await devultur.setLock(ctx, key, { until });
} catch (error) {
  const refusal = devulturErrorOf(error); // null when it isn't a Worker refusal
  if (refusal?.code === "compliance_extend_only") {
    // the date can only move later
  }
  throw error;
}
```

`isDevulturError(error)` is the matching type guard. Errors that aren't Worker refusals, such as a network failure,
are rethrown unchanged.

## Object lock

- `devultur.createUploadUrl(ctx, { filename, contentType, lock, hold })` locks a file from its first write.
- `devultur.getLock(ctx, key)` and `devultur.setLock(ctx, key, { mode, until, period, derivatives })` read and change
  a file's retention.
- `devultur.setHold(ctx, keys)` and `devultur.releaseHold(ctx, keys)` set and release holds.

These are server-side calls: `exposeApi` never lets a browser choose or change a lock. Its `createUploadUrl` applies
`config.upload.lock` instead. A bulk hold by prefix runs on your server with `@devultur/core`'s
`createWorkerClient(...).lock.holdAll({ prefix })`.

## Documentation

Guides and API reference: [github.com/devultur/devultur/tree/main/docs](https://github.com/devultur/devultur/tree/main/docs).

## License

[MIT](https://github.com/devultur/devultur/blob/main/LICENSE)
