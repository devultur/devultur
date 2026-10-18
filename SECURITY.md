# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
[Report a vulnerability](https://github.com/devultur/devultur/security/advisories/new) (Security tab, "Report a
vulnerability"). Don't open a public issue, pull request or discussion for a security problem.

Include the affected package and version, a description of the impact, and steps or a proof of concept to
reproduce it. You'll get an acknowledgement within a few days, and we'll keep you posted while we work on a fix.
We'll credit you in the advisory unless you'd rather stay anonymous.

## Supported versions

Security fixes land on the latest released version of each package. Please upgrade before reporting.

## Scope

- `@devultur/self-host`: the media Worker (authentication, delivery gate, tokens, signed links, webhooks,
  encryption at rest).
- `@devultur/core`, `@devultur/server`, `@devultur/react`, `@devultur/convex`: the SDKs.
- `infra/transcode`: the transcode image and the reference HTTP runner.

Misconfigurations of your own deployment (for example `createWorker({ auth: "custom" })` without a middleware that
rejects unauthenticated requests) are out of scope, but we welcome reports of unsafe defaults.
