"use client";

// The hooks that throw outside their provider, with their messages and `DevulturCapabilityError`. A build entry of its
// own (not a published subpath), like `./contexts`, so tsup emits them in a chunk apart from the contexts: an entry
// that only uses `useCanDeliver` or `useDevulturOptional` doesn't load them, and one that uses `useDevultur` doesn't
// load the URL hooks either.
export { useDevultur, useDevulturApi, useDevulturProgress } from "../provider-hooks";
