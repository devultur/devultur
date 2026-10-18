# Contributing

Thanks for helping. Small fixes can go straight to a pull request; for anything bigger, open an issue first so we
can agree on the approach.

## Setup

```bash
corepack enable        # uses the pnpm version pinned in package.json
pnpm install
pnpm build
pnpm test
```

Before you push, run `pnpm lint`, `pnpm typecheck` and `pnpm test`. CI runs the same checks.

## Conventions

- **pnpm** only. Don't commit a `package-lock.json` or `yarn.lock`.
- **Biome** lints and formats: `pnpm lint:fix`.
- **Conventional Commits**: `type(scope): description`, imperative and lowercase, for example
  `fix(self-host): reject expired download links`. Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`,
  `perf`.
- **Changesets**: a change to a published package needs one. Run `pnpm changeset`, pick the bump and commit the
  file. The five published packages share one version.
- Add or update tests with every behavior change.

## Developer Certificate of Origin

`@devultur/self-host` is AGPL-3.0-only and the SDKs are MIT. Your contribution is licensed under the license of the
package it touches. Because the project may need to change or add licenses in the future, it keeps a clear record of
where every change comes from: each commit must be signed off under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/).

```bash
git commit -s -m "fix(core): handle empty filenames"
```

`-s` adds a `Signed-off-by: Your Name <you@example.com>` line. It certifies that you wrote the change, or have the
right to submit it, under the project's licenses. Pull requests with unsigned commits can't be merged.

## Security

Don't report vulnerabilities in issues or pull requests. See [SECURITY.md](SECURITY.md).
