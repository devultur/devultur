# @devultur/convex

## 1.0.2

### Patch Changes

- [#9](https://github.com/devultur/devultur/pull/9) [`a73c6eb`](https://github.com/devultur/devultur/commit/a73c6ebff7ba73843931901b99236f409f2eb767) Thanks [@demarchenac](https://github.com/demarchenac)! - `devultur-init` now generates a `convex.config.ts` whose `defineApp()` declares `DEVULTUR_SECRET` and `DEVULTUR_API_URL`. Before, the generated config bound `app.env.DEVULTUR_SECRET` without declaring it, and Convex rejected it. When it patches an existing config that doesn't declare them, it prints the `env` to add.

- Updated dependencies []:
  - @devultur/core@1.0.2
  - @devultur/react@1.0.2

## 1.0.1

### Patch Changes

- [#1](https://github.com/devultur/devultur/pull/1) [`7c049c2`](https://github.com/devultur/devultur/commit/7c049c2b7613c2f7b01b92692e43c1150e025d11) Thanks [@demarchenac](https://github.com/demarchenac)! - Add a package description and keywords so the packages show up in npm search with a summary

- Updated dependencies [[`7c049c2`](https://github.com/devultur/devultur/commit/7c049c2b7613c2f7b01b92692e43c1150e025d11)]:
  - @devultur/core@1.0.1
  - @devultur/react@1.0.1
