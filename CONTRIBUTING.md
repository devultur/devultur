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

## Contributor License Agreement

`@devultur/self-host` is AGPL-3.0-only and the SDKs are MIT. Your contribution is licensed under the license of the
package it touches, and the project may also offer its code under other terms (for example, a commercial license
of the AGPL Worker). To keep that possible, every contributor signs the [Contributor License Agreement](CLA.md)
once: you keep the copyright of your work and grant a license to use it under the project's licenses or other
terms.

On your first pull request a bot asks you to sign by replying with a comment; it takes a minute and covers all your
future contributions. Pull requests from authors who haven't signed can't be merged.

## Security

Don't report vulnerabilities in issues or pull requests. See [SECURITY.md](SECURITY.md).
