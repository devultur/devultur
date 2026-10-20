# Retention and holds

Keep a file from being deleted or overwritten until a date, or until you say so (WORM storage). The media Worker
enforces it on every route that deletes or replaces stored bytes.

- [The model](#the-model)
- [Compliance and governance](#compliance-and-governance)
- [What's enforced, and where](#whats-enforced-and-where)
- [Derived files](#derived-files)
- [Transcoding a locked video](#transcoding-a-locked-video)
- [Locking at upload](#locking-at-upload)
- [Retention vs expiry](#retention-vs-expiry)
- [Changing a lock](#changing-a-lock)
- [Holds](#holds)
- [Audit](#audit)
- [Deleting a prefix from your own code](#deleting-a-prefix-from-your-own-code)
- [Caveats](#caveats)
- [Recipes](#recipes)

## The model

```typescript
type ObjectLock = {
  retention?: {
    mode: "governance" | "compliance";
    until?: string; // a fixed date (ISO 8601 with a time zone)
    period?: number; // or seconds from upload, or from the hold's release
    derivatives?: "inherit" | "original-only"; // default "inherit"
  };
  hold?: boolean; // retained indefinitely while true
};
```

- **Retention** keeps the file until `until`, or for `period` seconds (at most 100 years). Set one of the two: passing
  both is a `400`. A `period` counts from the upload, or from the moment a hold is released.
- **Hold** keeps the file indefinitely, whatever its retention says. Releasing it starts the retention's `period`.
  If there's no retention, the file is free again.

If you know S3 Object Lock or Google Cloud Storage, it's the same model:

| Here | S3 Object Lock | Google Cloud Storage |
| --- | --- | --- |
| `retention.mode: "compliance"` | Compliance mode | Object retention, `Locked` mode |
| `retention.mode: "governance"` | Governance mode (`s3:BypassGovernanceRetention`) | Object retention, `Unlocked` mode |
| `retention.until` | Retain until date | Retention expiration time |
| `hold` | Legal hold | Temporary hold |
| `hold` + `retention.period` | (no equivalent) | Event-based hold + retention period |

**Resolution order.** It works like `visibility` and the [security flags](security.md): the resource's own lock,
then the Worker's default (`config.lock`), then no lock. `hold` resolves on its own. `retention` resolves as a whole:
its mode and its date come from the same level, so `until` and `period` never mix. `derivatives` falls back to the
default's, then to `inherit`. A resource can replace the default retention but can't drop it.

A past `until` is valid. It just means the file isn't locked any more, so a default with a fixed date keeps working
after that date passes.

## Compliance and governance

- **`compliance`**: nobody can delete or overwrite the file before its date, and the lock can only get stricter. Its
  date can move later, it can't switch to `governance`, and it can't move from `inherit` to `original-only`. Not even
  the Worker secret can shorten it.
- **`governance`**: the same, except that a privileged call can shorten or remove it. Privileged means the request
  asks for `bypassGovernance: true` **and** an [`authorizeLockChange`](plugins.md#hooks) plugin approves it. Without
  such a plugin, nothing can shorten a governance retention (`403 lock_privilege_required`).

Any lock can be made stricter without privilege: set a later date, a longer period, `inherit`, or a hold. An expired
retention can be replaced freely.

While a hold is set, a `period` can't be swapped for a fixed `until`. The period only starts at the release, so any
date could end before it: compliance refuses it, and governance needs the privilege. Release the hold first, or
extend the period.

## What's enforced, and where

The Worker checks the lock before it deletes or replaces anything:

| Path | A locked file |
| --- | --- |
| `DELETE /v1/media/<key>` | `409 retention_active`. Its image variants and encryption keys stay too. |
| `DELETE /v1/media/videos/<id>` | `409 retention_active` when any of the video's originals is locked. Nothing is deleted. |
| Deleting a file's encryption keys | Refused the same way, since deleting them destroys the file (crypto-shredding) |
| `PUT /v1/upload/<key>`, multipart create and complete | `409 retention_active` when they would replace a locked file |
| `POST /v1/upload` with `overwrite: true` | `409 retention_active` before any bytes are sent |
| `POST /v1/captions` | `409 retention_active` for a locale that already exists on a locked video. A new locale is allowed. |
| `POST /v1/transcode` | `409 retention_active` for a re-transcode (see [Transcoding a locked video](#transcoding-a-locked-video)) |
| `transcode.complete` with `deleteOriginalOnSuccess` | The original is kept (see [below](#transcoding-a-locked-video)) |

A write to a key that doesn't exist yet is a create, not an overwrite, so it's always allowed.

Every write is conditional on the object the check saw. If the file changes between the check and the write (for
example, a lock lands meanwhile), R2 refuses the write and the Worker answers `409 write_conflict`. The Worker doesn't
retry, because the new object may be locked: retry the request and you get the current answer.

A refused delete or overwrite answers:

```json
{
  "error": "private/file/f1/deed.pdf is retained and can't be deleted",
  "code": "retention_active",
  "key": "private/file/f1/deed.pdf",
  "mode": "compliance",
  "until": "2031-01-01T00:00:00.000Z",
  "hold": false
}
```

`key` names the locked original. For a derived file (a caption, an HLS segment), that's the video's original. `mode`
is left out for a hold with no retention, and `until` is left out while a hold keeps a `period` from starting.

All the lock error codes:

| Status | `code` | When |
| --- | --- | --- |
| `409` | `retention_active` | A delete or overwrite of a locked file |
| `409` | `write_conflict` | The file changed between the check and the write: retry |
| `409` | `compliance_extend_only` | A change that would weaken a compliance retention |
| `409` | `lock_conflict` | Another lock change landed first: retry |
| `409` | `lock_record_unreadable` | A change to a file whose lock record can't be read (see [Caveats](#caveats)) |
| `403` | `lock_privilege_required` | Shortening or removing a governance retention without an approved bypass |
| `403` | `lock_below_minimum` | An upload asks for a looser lock than its upload token requires |
| `400` | `invalid_lock`, `invalid_hold` | A malformed lock or hold request |
| `400` | `reserved_key` | A key under `__lock/` or `__lock-audit/`, which the Worker keeps for itself |

Owner reads (the Worker secret on `GET /v1/media/<key>`) also get `x-devultur-lock-until` and, while a hold is set,
`x-devultur-lock-hold: true`. An owner read never goes through the edge cache: it isn't answered from a public copy
and doesn't store one. Its `Cache-Control` is the private form of the file's own, so no shared cache keeps the lock
headers either.

## Derived files

A video's transcode outputs and captions live under its folder (`{visibility}/video/{id}/…`).
`retention.derivatives` decides whether they're retained with the original:

- **`inherit`** (the default): transcode outputs and captions can't be deleted or overwritten while the original is
  locked. New outputs and new caption locales can still be added.
- **`original-only`**: only the uploaded file is retained. Its outputs and captions can be deleted or regenerated
  freely. Deleting the whole video is still refused, since the original is in it.

Image variants and mezzanines are regenerable caches. They're never retained.

Derived files also expire with their original. An HLS playlist or segment, an MP4, a thumbnail, poster or storyboard
written by the transcode runner gets the earliest `expiresAt` of the video's raws, and a caption gets the one of the
file it was made from. Past it, they answer `410` like the original. The value is copied when the output is written
(the raw is deleted by `deleteOriginalOnSuccess` only after the transcode completes), so changing a raw's expiry
later doesn't reach outputs already written. The HLS encryption key (`.key`) has no expiry of its own: it's useless
without the segments.

## Transcoding a locked video

- **The first transcode** of a locked video is allowed, since it only creates outputs.
- **A transcode that never completed** (failed, or the runner died) can be retried, and the new job may overwrite
  the partial outputs.
- **Once a transcode has completed**, re-transcoding is refused with `409 retention_active`, because it would
  overwrite retained outputs. The Worker records the completion durably, under
  `__lock/{visibility}/video/{id}/transcode-completed`.
- **While a job is in progress** (`queued` or `running`), the runner may rewrite its own outputs (HLS, MP4,
  thumbnails, storyboard), for example to retry an upload. From `transcode.complete` on, they're protected like any
  derived file.

**Deleting the original after transcode.** With `transcode.deleteOriginalOnSuccess`, the Worker deletes the original
once a transcode completes. A locked original wins: it's kept, the skip is audited (`original_retained`), and the
webhook still succeeds. `getRouteResult(context).originalRetained` tells a plugin it happened. The original keeps
taking storage until its lock ends, and in Infrequent Access (`originalStorageClass`) it also keeps that class's
30-day minimum and per-read retrieval charge. Once the lock ends, delete it yourself: `deleteOriginalOnSuccess`
doesn't come back for it.

## Locking at upload

An upload can carry its lock, so the file never exists unprotected. The lock is written with the bytes, and nothing
can strip it later (the Worker drops a `lock` key from `config.uploadMetadata`).

```typescript
const client = createWorkerClient(secret, workerUrl);

await client.createUploadUrl({
  filename: "deed.pdf",
  contentType: "application/pdf",
  lock: { retention: { mode: "compliance", period: 7 * 365 * 24 * 3600 } },
});
await client.createUploadUrl({ filename: "evidence.mp4", contentType: "video/mp4", hold: true });
```

`hold: true` is shorthand for `lock: { hold: true }`. `uploadFile` and `uploads.uploadAsset` take the same options.
A Worker-wide default goes in `config.lock`:

```typescript
export default createWorker({
  plugins: defaultPlugins({ lock: { retention: { mode: "governance", period: 30 * 24 * 3600 } } }),
});
```

**Upload tokens** can pin a minimum lock: `uploads.createToken({ prefix, lock })`. An upload with that token gets at
least that lock. It can ask for a stricter one, never a looser one (`403 lock_below_minimum`).

**Expiry.** A lock may outlive the file's `expiresAt` (`expiresIn`, the token's or the config's TTL): see
[Retention vs expiry](#retention-vs-expiry).

**Uploads without a pending upload.** A `PUT /v1/upload/<key>` with the Worker secret and no `POST /v1/upload` before
it gets `config.lock` too, unless the key is a video's derived output (those follow their original through
`derivatives`).

Locks need the media Worker. In direct-storage mode, `createMediaRouter` throws when an upload asks for a lock,
because a presigned PUT to the bucket can't enforce one.

## Retention vs expiry

Retention and expiry are separate, as in S3 Object Lock. **Retention preserves** the object: it can't be deleted or
overwritten. **Expiry ends access** to it: past `expiresAt`, nobody but the owner reads it, and that covers a video's
transcode outputs and captions (see [Derived files](#derived-files)). A lock doesn't extend access, and an expiry
doesn't shorten a lock. A file can be shared for 30 days and kept for 10 years.

| State | Viewers, public requests, download links | The owner (Worker secret) | The object |
| --- | --- | --- | --- |
| Before `expiresAt` | Normal access | Normal access | Kept (and protected while locked) |
| After `expiresAt`, still retained | `410` | Can read it, to export or audit | Not deleted: delete and overwrite answer `409 retention_active` |
| After `expiresAt`, free | `410` | `410` | Stays in the bucket until your expiry cleanup deletes it |

- **Download links are access.** A link never outlives the file's `expiresAt`, even for a retained file. Creating one
  for an expired file answers `410`, and redeeming one after the file expired does too.
- **Edge copies.** A public file's edge copy never outlives its `expiresAt`: its TTL is capped there, and a copy found
  past it is ignored, so the request reaches the Worker and gets `410`.
- **Listings.** `GET /v1/assets` (an owner route) includes an expired file that's still retained, marked
  `expired: true` with `retainedUntil` (its retention's end) or `hold: true`. An expired free file isn't listed.
  Telling them apart reads each expired file's lock record (one subrequest each), so a page reads at most 32
  (`MAX_EXPIRED_LOOKUPS`): past that, it ends early with a `cursor` that resumes right after its last entry. A page
  can hold fewer entries than `limit` while more remain; keep following the `cursor` until it's `null`.
- **The expiry cleanup is yours to run.** Nothing in `@devultur/self-host` deletes expired files: the Worker only
  refuses access to them. Run your own job (a cron Worker, a script) that deletes them through the Worker
  (`DELETE /v1/media/<key>`, or `/v1/media/videos/<id>` for a video), so each delete goes through the lock check: a
  retained file answers `409 retention_active` and is kept until its lock ends, then the job's next run deletes it.
  Don't use an R2 lifecycle rule for it: it doesn't go through the Worker and deletes retained files too (see
  [Caveats](#caveats)).

## Changing a lock

`GET /v1/lock/<key>` and `PUT /v1/lock/<key>` are control routes. The default auth accepts only the Worker secret.

```typescript
await client.lock.get(key);
// { key, mode, until, period, hold, derivatives, source: "upload" | "sidecar" | "none", revision }

await client.lock.set(key, { until: "2032-01-01T00:00:00Z" }); // extend
await client.lock.set(key, { mode: "governance", period: 90 * 24 * 3600 }); // set on an unlocked file
await client.lock.set(key, { until: "2026-12-31T00:00:00Z", bypassGovernance: true }); // shorten (governance)
await client.lock.set(key, { remove: true, bypassGovernance: true }); // remove (governance)
```

The fields merge over the current retention, and `until` and `period` replace each other. `PUT` changes the retention
only. Holds have [their own route](#holds).

R2 can't edit an object's metadata in place, so a change goes to a small record at `{storagePrefix}__lock/<key>`. The
record is bound to the object version it was written for (R2's per-write `version`, never the etag, which repeats when
the same bytes are uploaded again). Deleting or overwriting the file leaves the record in place, inert: it never
applies to another version, so a file uploaded again at the same key starts from its own upload lock, and a lock
change made on the new file right after it landed can't be lost to a cleanup of the old record. A record of a deleted
file is a few hundred bytes and stays as evidence of its last lock. To reclaim them, delete only records whose file no
longer exists: deleting the record of an existing file drops every change made to its lock. Two concurrent changes
can't both land: the second gets `409 lock_conflict`.

## Holds

`POST /v1/lock/hold` is the one way to set or release a hold, including on a single file:

```typescript
await client.lock.hold([key]);
await client.lock.release([key]);

// Every page of a prefix, or a long list of keys
for await (const page of client.lock.holdAll({ prefix: "private/asset/case-17/" })) {
  console.log(page.updated, page.skipped);
}
```

- A request names up to 50 keys (`HOLD_PAGE_SIZE`), or a prefix. A prefix is walked 50 objects per request, with a
  `cursor`. Each object costs about four subrequests, so a page stays well under the Workers limit. `holdAll` and
  `releaseAll` follow the cursor and split long key lists for you.
- The answer is `{ updated: string[], skipped: { key, reason }[], cursor? }`. The `reason` is `not_found`,
  `unchanged` (already in that state), `lock_conflict` (changed concurrently: retry it) or `lock_record_unreadable`
  (a release of a file whose lock record can't be read, see [Caveats](#caveats)).
- A hold never touches the retention, so it can only add protection. A hold on a compliance file is allowed, and its
  date stays.
- **Releasing:** with a `retention.period`, the period starts now. With a fixed `until`, that date still applies.
  With no retention, the file is free.
- Image variants under a prefix are skipped, since they're caches. The Worker's own records (`__lock/`,
  `__lock-audit/`) are never listed or changed, whatever the prefix.

## Audit

Every lock event gets one record. That covers every change (including holds and releases), the lock set at upload,
every rejected delete or overwrite, and every original kept after a transcode.

```typescript
interface LockAuditRecord {
  at: string; // ISO time
  action: "set" | "extend" | "shorten" | "remove" | "hold" | "release"
    | "delete_rejected" | "overwrite_rejected" | "original_retained";
  keys: string[];
  before: ObjectLock | null;
  after: ObjectLock | null;
  actor: PluginContext | null; // the request's plugin context; for an upload, the uploader's
  outcome: "applied" | "rejected" | "skipped";
  bypass?: true; // the change used the governance privilege
  reason?: string; // why it was rejected
}
```

Each record goes to three places:

- a structured log line (`{"event":"lock.audit", …}`);
- one create-only object at `{storagePrefix}__lock-audit/{yyyy-mm-dd}/{ts}-{uuid}.json` in the media bucket;
- every plugin's [`onLockAudit`](plugins.md#hooks) hook, to store it elsewhere.

The object and the hooks run after the response. A failure there is logged, never surfaced. The audit isn't a general
access log: reads aren't recorded.

## Deleting a prefix from your own code

Code that runs in your Worker and deletes whole prefixes straight from the R2 binding (an app's teardown, a user's
data export cleanup, a sweeper for expired files) bypasses the routes' checks. `@devultur/self-host` exports the
guard's lock resolution for it, so it can skip retained files:

```typescript
import { deletePrefixRespectingLocks, readObjectLock, retainedSummary } from "@devultur/self-host";

// The lock in force on one stored object (its full R2 key), or null when there's no such object.
const lock = await readObjectLock({ mediaBucket: env.MEDIA_BUCKET }, "apps/a1/private/file/f1/deed.pdf");
// { locked: true, hold: false, until: "2031-01-01T00:00:00.000Z", mode: "compliance" }

// Delete what's free under a storage prefix, keep what's retained. Call again with `cursor` until it's gone.
let cursor: string | undefined;
do {
  const result = await deletePrefixRespectingLocks({
    mediaBucket: env.MEDIA_BUCKET,
    keysBucket: env.KEYS_BUCKET,
    prefix: "apps/a1/",
    cursor,
  });
  // result: { deletedCount, deletedBytes, deletedKeyCount, retainedCount, retainedBytes, retained, cursor?, subrequests }
  cursor = result.cursor;
} while (cursor);
```

- **Keys are storage keys**: the full R2 keys, your storage prefix included. Nothing needs a request. The storage
  prefix each key lives under (where its lock record is) is read from the key: everything before its first `public/`
  or `private/` segment. Pass `root` when you walk a single storage prefix that has a segment named `public` or
  `private`. One prefix can span several storage prefixes, each read on its own.
- **Same resolution as the routes.** The upload's lock, or the lock record bound to the stored version (a record left
  by a replaced version is ignored). An unreadable record counts as held (`unreadable: true`). A video's files inherit
  from its raws unless they're `original-only`, and an image's variants follow it, as `DELETE /v1/media/<key>` keeps
  them. `lockedBy` names the original whose lock it is.
- **What goes.** A free object goes the way `DELETE /v1/media/<key>` deletes it: with its encryption keys in
  `KEYS_BUCKET` (except those of an upload in flight over it) and its variants'. A video folder left empty also loses
  the rest of its keys (the HLS key) and its transcode-completed marker, as with `DELETE /v1/media/videos/<id>`.
- **What stays.** Retained files, with their variants, keys and lock records. The lock records of deleted files stay
  too, inert, as with the routes. Nothing under `__lock/` or `__lock-audit/` is touched: once a storage prefix has
  nothing retained left, delete those yourself if you're tearing it down.
- **Bounded.** A Worker invocation has a subrequest limit. Each call stops before `maxSubrequests` bucket calls
  and returns a `cursor` to go on from. The default, 40, fits under the Workers Free plan's 50 subrequests per
  request and leaves room for your own calls. On a paid plan, raise it (to a few hundred, say) so each call gets
  further. `batchSize` (default 100, at most 1000) sets how many objects it
  lists at a time. Run a large prefix over several invocations (a queue, or a cron that keeps the cursor).
- **Not audited.** The call is your code, not a request, so no audit record or hook runs: log `retained` if you need a
  trail. The [check/delete window](#caveats) applies.

`retainedSummary({ mediaBucket, prefix, cursor? })` answers "can this be deleted?" without deleting anything:
`{ scannedCount, retainedCount, retainedBytes, latestUntil?, hasHold, cursor?, subrequests }`, with the same bounds.
Add up the counts of each call. With `hasHold`, something stays until it's released, not until `latestUntil`.

## Caveats

- **The check/delete window.** R2 deletes aren't conditional, so a lock set in the milliseconds between the Worker's
  check and its delete isn't seen. Writes are conditional, and protected.
- **Only the Worker enforces locks.** R2 lifecycle rules, the R2 dashboard, `wrangler r2`, and any S3 or binding
  access that doesn't go through the Worker can delete a locked file. Treat locks as compliance only as long as nobody
  else can write to the bucket. This isn't a certified WORM store.
- **R2 bucket locks** can be an optional second layer: an R2 bucket lock rule refuses deletes at the storage level.
  Anyone who can edit the bucket's configuration can remove the rule, though, so it raises the bar rather than
  closing it.
- **The runner credential.** While a transcode job is in progress, a request with the runner's credential may rewrite
  that job's outputs on a locked video. With `workerSecretAuth()`, that credential is `WORKER_AUTH_SECRET`, which your
  backend holds too. To limit the exemption to the runner, give the runner a narrower credential from your own auth
  plugin (`updateRequestState(context, { runnerCredential })`) and accept it only for uploads of transcode outputs.
- **Direct storage** (`createMediaRouter` with your own bucket and no Worker) refuses locks: nothing would enforce
  them.
- **`deletePrefix`**, exported by `@devultur/self-host`, deletes everything under a prefix and bypasses locks. Use it
  only for regenerable data. The routes delete through the guarded helpers; your own code can use
  [`deletePrefixRespectingLocks`](#deleting-a-prefix-from-your-own-code).
- **Listings show retention.** An expired, retained entry of `GET /v1/assets` carries `retainedUntil` and `hold`:
  whoever can list a prefix learns what's retained in it. With `workerSecretAuth()`, listing takes the Worker secret,
  the same credential as `GET /v1/lock`. An auth plugin of your own that lets a narrower credential list (a sync
  script's, say) gives it that view too. If that credential shouldn't see what's retained, keep it off
  `GET /v1/assets`.
- **An unreadable lock record** (the record at `__lock/<key>`, or the upload's `lock` metadata, isn't valid JSON or
  isn't a valid lock) fails closed: the file reads as held, for whatever version is stored at the key. Since nobody can
  tell what it really said (it might be a compliance retention), the API never weakens it: a release is skipped with
  `lock_record_unreadable`, `PUT /v1/lock/<key>` answers `409 lock_record_unreadable`, and deletes and overwrites
  answer `409 retention_active`. Recovery is an operator's job, outside the Worker: find the record's last good
  content in the audit (the `after` of the key's last `applied` record under `__lock-audit/`), write it back to
  `__lock/<key>` as `{ revision, objectVersion, lock, updatedAt }` with the current object's R2 `version` as
  `objectVersion` (for bad upload metadata, `lock` is the lock it was uploaded with), and check it with
  `GET /v1/lock/<key>`.

## Recipes

### Keep a record until N years after an event

The end date depends on an event that hasn't happened yet (a contract ends, a case closes). Upload with a hold and a
`period`, and release the hold when the event happens: the period starts then.

```typescript
const SEVEN_YEARS = 7 * 365 * 24 * 3600;

// At upload: retained indefinitely until the event
const upload = await client.createUploadUrl({
  filename: "record.pdf",
  contentType: "application/pdf",
  lock: { retention: { mode: "compliance", period: SEVEN_YEARS }, hold: true },
});

// When the event happens: the 7 years start now
await client.lock.release([upload.key]);

// Or every file of the record at once
for await (const page of client.lock.releaseAll({ prefix: "private/asset/record-42/" })) {
  if (page.skipped.length > 0) console.warn(page.skipped);
}
```

### Share for 30 days, keep for 10 years

Access ends after 30 days, and the file stays (undeletable) for 10 years:

```typescript
await client.createUploadUrl({
  filename: "statement.pdf",
  contentType: "application/pdf",
  expiresIn: 30 * 24 * 3600,
  lock: { retention: { mode: "compliance", period: 10 * 365 * 24 * 3600 } },
});
```

After 30 days, viewers and download links get `410`. Your backend can still read the file with the Worker secret,
and `GET /v1/assets` lists it with `expired: true` and `retainedUntil`. Until the 10 years pass, your
[expiry cleanup](#retention-vs-expiry) gets `409 retention_active` for it; its first run after that deletes it.

### Compliance retention for N years from upload

```typescript
export default createWorker({
  plugins: defaultPlugins({
    lock: { retention: { mode: "compliance", period: 10 * 365 * 24 * 3600 } },
  }),
});
```

Every upload gets the lock, unless it asks for a stricter one. To scope it to some uploads, set the lock per upload
instead, or hand out [upload tokens](#locking-at-upload) with a minimum `lock`.

### Convex

The [Convex component](../../packages/convex/README.md#object-lock) exposes the same operations to your own
functions. A Worker refusal arrives as a `ConvexError` whose `data.code` is the code above:

```typescript
import { Devultur, devulturErrorOf } from "@devultur/convex";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { action } from "./_generated/server";

const devultur = new Devultur(components.devultur);

export const extendRetention = action({
  args: { key: v.string(), until: v.string() },
  handler: async (ctx, { key, until }) => {
    try {
      return await devultur.setLock(ctx, key, { until });
    } catch (error) {
      const refusal = devulturErrorOf(error);
      if (refusal?.code === "compliance_extend_only") return { ok: false, reason: "can only move later" } as const;
      if (refusal?.code === "lock_conflict") return devultur.setLock(ctx, key, { until }); // changed meanwhile
      throw error;
    }
  },
});

export const deleteFile = action({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    try {
      await ctx.runAction(components.devultur.public.deleteMediaAction, { key });
    } catch (error) {
      const refusal = devulturErrorOf(error);
      // { key, mode, until, hold } of the locked original
      if (refusal?.code === "retention_active") return { deleted: false, lock: refusal.details } as const;
      throw error;
    }
    return { deleted: true } as const;
  },
});
```
