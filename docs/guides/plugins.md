# Plugins

The media Worker is built from plugins. `createWorker()` is `createWorker({ plugins: defaultPlugins() })`: the
Worker secret auth, the rules of every request, the credential policy and download links are plugins that use the
same API as yours. Add plugins to extend the Worker, or replace a default one.

```typescript
import { createWorker, defaultPlugins } from "@devultur/self-host";
import { usageLog } from "./plugins/usage-log";

export { DownloadLink } from "@devultur/self-host";

export default createWorker({
  plugins: [...defaultPlugins({ transcode: { maxResolution: "1080p" } }), usageLog()],
});
```

## Default plugins

| Plugin | What it does |
| --- | --- |
| `staticConfig(config)` | Applies the [rules](self-host.md#rules) to every request. Put it first: later plugins narrow it. |
| `workerSecretAuth()` | Control routes require `Authorization: Bearer <WORKER_AUTH_SECRET>`; the transcode runner uploads with the same secret. |
| `credentialPolicy(options?)` | Decides before a credential is issued. Without options it issues what is asked; `maxTtlSeconds: { viewer: 3600 }` caps a kind. |
| `downloadLinks()` | `POST /v1/token/download` and `GET /v1/download/<id>` (needs the `DOWNLOAD_LINKS` Durable Object). Without it both answer `404`. |

`createWorker()` refuses to start when no plugin authenticates requests, so dropping `workerSecretAuth()` without
an auth plugin of yours fails at deploy, not in production.

## Writing a plugin

A plugin is an object:

```typescript
interface WorkerPlugin {
  name: string;
  middleware?: {
    beforeAuth?: MiddlewareHandler[];
    auth?: MiddlewareHandler[];
    afterAuth?: MiddlewareHandler[];
  };
  routes?: Array<{ path: string; app: Hono }>;
  issueCredential?: (context: Context, request: CredentialRequest) => CredentialDecision | Promise<CredentialDecision>;
  beforeLinkRedeem?: (context: Context, link: DownloadLinkInfo) => Response | null | Promise<Response | null>;
  authorizeLockChange?: (context: Context, request: LockChangeRequest) => LockChangeDecision | Promise<LockChangeDecision>;
  onLockAudit?: (context: Context, record: LockAuditRecord) => void | Promise<void>;
  onMediaEvent?: (context: Context, event: WebhookEvent) => void | Promise<void>;
  resolveWebhookTarget?: (env: WorkerEnv, scope: string) => WebhookConfig | null | Promise<WebhookConfig | null>;
}
```

Middleware are [Hono](https://hono.dev) middleware. Every request goes through all plugins' `beforeAuth`, then
their `auth`, then their `afterAuth`, each phase in plugin order, and then the route:

- **`beforeAuth`**: work that doesn't need to know the caller, like rate limiting or an endpoint the plugin answers
  itself.
- **`auth`**: who is calling and what the request may touch. At least one plugin needs it.
- **`afterAuth`**: authorization and per-request rules, and anything that reads `context.res` after `await next()`
  (logs, metrics, cache purges).

`routes` are mounted after the Worker's own routes, behind every plugin's middleware.

## Request state

A plugin tells the routes about the current request with `updateRequestState(context, patch)`, and reads it with
`getRequestState(context)`. Top-level fields replace; `config`, `access` and `context` merge field by field.

| Field | What it does |
| --- | --- |
| `storagePrefix` | Prefix of every storage key the request touches (`""` = the bucket root). Keeps each of your apps in its own folder. |
| `config` | The [rules](self-host.md#rules), field by field over `staticConfig` |
| `access.authenticated` | The credential was verified. Without it, an upload URL only acts on the upload an authenticated `POST /v1/upload` created. |
| `access.trustedRead` | Serve private media without a viewer token. Only set it for a credential sent in `Authorization`, never for a `?token=` query. |
| `access.uploadGrant` | The credential is an upload token: `POST /v1/upload` stays inside its prefix |
| `runnerCredential` | Bearer the transcode runner uploads its outputs with (`workerSecretAuth()` sets the Worker secret) |
| `webhookCredential` | Bearer sent to a job's `callbackUrl`. Unset: `runnerCredential`; `""`: none. |
| `context` | Plugin context: see below |

### Plugin context

`context` is any JSON a plugin attaches to the request. The Worker stores it with the uploads and download links the
request creates and in the transcode job, and hands it back when they're used: the upload PUT, a link redemption and
the runner's callbacks carry no credential, so it's how a plugin knows who started them. The Worker never reads it.

Type your plugin's keys by augmenting the interface:

```typescript
declare module "@devultur/self-host" {
  interface PluginContext {
    appId?: string;
  }
}

updateRequestState(context, { context: { appId: "web" } });
```

## Hooks

**`issueCredential`** runs before the Worker issues a viewer token, an upload token, a download link or the runner's
service token. It gets the `kind`, the `scopes`, the `path` it is bound to and the requested `expiresAt` (epoch ms).
Return `{ allow: false, response }` to refuse, or `{ allow: true, expiresAt?, claims? }` to issue it: `expiresAt`
caps the expiry, and `claims` are added to a token. The hooks of every plugin run in order: the first refusal wins,
the earliest `expiresAt` applies, and the claims of all of them are added.

```typescript
const viewerTokensOnlyRead: WorkerPlugin = {
  name: "viewer-tokens-only-read",
  issueCredential: (context, { kind, scopes }) => {
    if (kind === "viewer" && scopes.some((scope) => scope !== "media:read")) {
      return { allow: false, response: context.json({ error: "Viewer tokens only read" }, 403) };
    }
    return { allow: true };
  },
};
```

The Worker sets the claims that bound a token itself, and a plugin can't override them: `aud` is the storage
prefix it was issued under (without its trailing slash) and `scope` its space-separated scopes. The delivery gate
also enforces `res`, a path prefix its keys must fall under, when a plugin adds it. A token outside what its claims
allow gets `403 { "code": "token_rejected" }`; which claim failed is only logged.

**`beforeLinkRedeem`** runs before `GET /v1/download/<id>` spends a use of a link. Return a `Response` to refuse it
(the use isn't spent), or `null` to let it go on. It gets the link's `storagePrefix`, `key` and plugin `context`.

**`authorizeLockChange`** runs before the Worker changes a lock ([Retention and holds](object-lock.md)):
`PUT /v1/lock/<key>` once per change, and `POST /v1/lock/hold` once per page. It gets:

- `action`: `set`, `extend`, `shorten`, `remove`, `hold` or `release`;
- `keys`, and the `prefix` of a bulk hold;
- `before` and `after`, the locks (`null` / `{ hold }` for a hold page).

Return `{ allow: false, response }` to refuse, or `{ allow: true }`. The first refusal wins. The hook also decides
the governance privilege: shortening or removing a governance retention takes `bypassGovernance: true` in the request
**and** at least one `authorizeLockChange` hook, with every hook allowing it. With no such hook, nothing can shorten a
governance retention.

This one lets only a records officer, who sends a second credential, shorten or remove a governance retention:

```typescript
import { isBearerOf } from "@devultur/core";
import type { WorkerPlugin } from "@devultur/self-host";

const recordsOfficer: WorkerPlugin = {
  name: "records-officer",
  authorizeLockChange: (context, { action }) => {
    if (action !== "shorten" && action !== "remove") return { allow: true };
    // Bound with `wrangler secret put RECORDS_OFFICER_SECRET`; the request still carries the Worker secret.
    if (isBearerOf(context.req.header("X-Records-Officer"), context.env.RECORDS_OFFICER_SECRET)) {
      return { allow: true };
    }
    return {
      allow: false,
      response: context.json({ error: "Only a records officer can shorten a retention", code: "officer_required" }, 403),
    };
  },
};
```

**`onLockAudit`** gets every [audit record](object-lock.md#audit) after the response (`waitUntil`): lock changes, the
lock set at upload, refused deletes and overwrites, and originals kept after a transcode. Use it to store the records
somewhere other than the default `__lock-audit/` objects, for example a database or a log pipeline. A failure is
logged and never reaches the caller.

```typescript
const auditToD1: WorkerPlugin = {
  name: "audit-to-d1",
  onLockAudit: async (context, record) => {
    await context.env.AUDIT_DB.prepare("INSERT INTO lock_audit (at, action, keys, record) VALUES (?, ?, ?, ?)")
      .bind(record.at, record.action, record.keys.join(" "), JSON.stringify(record))
      .run();
  },
};
```

**`onMediaEvent`** gets every media event (`media.deleted`, `media.changed`) after the response. While any plugin has
one, the Worker's own signed webhook isn't sent: deliver them your own way (a queue, a database, a webhook of
your own). See [Media webhooks](webhooks.md#delivering-events-your-own-way).

**`resolveWebhookTarget`** resolves a `config.webhooks.scope` your plugin sets to its URL and current secrets, when a
queued event or a transcode's callback is delivered: only the scope is ever stored. See
[Secrets are never stored](webhooks.md#secrets-are-never-stored).

## After the route

- `getRouteResult(context)` tells a middleware that runs after `await next()` what the route did: `redeemedLink`
  (the download link just redeemed), `originalDeleted` (`transcode.complete` deleted the original),
  `originalRetained` (it kept a locked original instead) and
  `transcodeJob` (the job a runner callback belongs to, with its plugin `context`).
- `getPendingUpload(context)`, before the route, returns the upload an upload URL points to: its key, storage key,
  content type and plugin `context`. `cancelPendingUpload(context, uploadUrl)` makes an upload URL stop working, for
  a plugin that rejects an upload after `POST /v1/upload` created it.
- `parseEncodeMetrics(body)` reads the encode measurement of a runner's `transcode.complete`
  (see [Measuring encode cost](self-host.md#measuring-encode-cost)).

## Deleting from a plugin

A plugin route (or a scheduled handler next to the Worker) that deletes from `MEDIA_BUCKET` directly skips the
routes' lock checks. Delete a prefix with `deletePrefixRespectingLocks` instead, and read one object's lock with
`readObjectLock`: they keep retained files, their keys and their lock records, and stay within a subrequest bound
(see [Deleting a prefix from your own code](object-lock.md#deleting-a-prefix-from-your-own-code)). The storage
prefix of the request is `getRequestState(context).storagePrefix`. Its `onDeleted` option reports what it deleted, to
send `media.deleted` events (see [Media webhooks](webhooks.md#deleting-a-prefix-from-your-own-code)).

## Example plugins

Three small plugins in [`examples/plugins`](../../examples/plugins/src), typechecked and tested with the packages:

- **[`jwt-auth`](../../examples/plugins/src/jwt-auth.ts)** authenticates with JWTs from your identity provider
  (its JWKS, or a shared HS256 `JWT_SECRET`) instead of the Worker secret, and can map a claim to a storage
  prefix. The transcode runner keeps using the Worker secret, so a job outlives any user token.
- **[`usage-log`](../../examples/plugins/src/usage-log.ts)** records the bytes and requests of media delivery and
  download links, counted as they stream, into the log or a D1 table.
- **[`rate-limit`](../../examples/plugins/src/rate-limit.ts)** answers `429` to a client over its limit, with
  Cloudflare's Rate Limiting binding, before any token is verified.

[`worker.ts`](../../examples/plugins/src/worker.ts) puts them together.
