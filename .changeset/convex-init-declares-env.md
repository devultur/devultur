---
"@devultur/convex": patch
---

`devultur-init` now generates a `convex.config.ts` whose `defineApp()` declares `DEVULTUR_SECRET` and `DEVULTUR_API_URL`. Before, the generated config bound `app.env.DEVULTUR_SECRET` without declaring it, and Convex rejected it. When it patches an existing config that doesn't declare them, it prints the `env` to add.
