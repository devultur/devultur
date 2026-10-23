---
"@devultur/convex": minor
"@devultur/react": minor
---

- `<DevulturViewerProvider>` issues the viewer token only once a private media is shown, and takes no `issueViewerToken` at all when every media is public: it then needs no Convex client. `useDevultur().requestToken()` asks for the token from code that reads `token` itself.
- `config.upload.visibility` sets the visibility of an upload whose caller passes none. A guard can return `args` to rewrite the caller's arguments on the server; they win over the browser's, which win over the config's default.
- `<VideoPlayer labels>` replaces any of the player's strings (`VideoPlayerLabels`, `defaultVideoPlayerLabels`), and so does the `labels` prop of each control. `@devultur/convex/locales/es` and `locales/es-formal` export `videoPlayerLabels`.
- `useDevulturOptional()` returns the provider's value, or `null` outside a provider instead of throwing.
- The docs describe the player's playback metrics: on by default, anonymous, no cookies, what each beacon carries and where it goes, and `metrics={false}` to turn them off.
