---
"@devultur/convex": minor
"@devultur/react": minor
---

- `<DevulturViewerProvider>` takes no `issueViewerToken` when every media is public: it then needs no Convex client and issues nothing. With an action it still issues the token as soon as it mounts; `lazyToken` issues it only once a private media is shown, and `useDevultur().requestToken()` asks for it from code that reads `token` itself.
- `config.upload.visibility` sets the visibility of an upload whose caller passes none. A guard can return `rewrite: { name, args }` to rewrite the caller's arguments on the server, typed for the named operation; it wins over the browser's arguments, which win over the config's default.
- `<VideoPlayer labels>` replaces any of the player's strings (`VideoPlayerLabels`, `defaultVideoPlayerLabels`), and so does the `labels` prop of each control. `@devultur/convex/locales/es` and `locales/es-formal` export `videoPlayerLabels`.
- `<Preview metrics>` passes `metrics` to a video's player, and a private video shows `loading` until its viewer token is issued instead of a refused first request.
- `useDevulturOptional()` returns the provider's value, or `null` outside a provider instead of throwing.
- The docs describe the player's playback metrics: on by default, anonymous, no cookies, what each beacon carries and where it goes, and `metrics={false}` to turn them off.
