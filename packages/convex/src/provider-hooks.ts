"use client";

// The hooks that throw outside the provider they need. Apart from the contexts (`devultur-context.ts`,
// `progress-context.ts`) so their error messages and `DevulturCapabilityError` land in a chunk of their own: an entry
// that only uses `useCanDeliver` or `useDevulturOptional` doesn't load them.
import React from "react";
import { DevulturCapabilityError } from "./capability-error";
import { type DevulturApi, DevulturApiContext, DevulturContext, type DevulturContextValue } from "./devultur-context";
import { DevulturProgressContext, type DevulturProgressContextValue } from "./progress-context";

export function useDevultur(): DevulturContextValue {
	const context = React.use(DevulturContext);
	if (!context) throw new Error("useDevultur must be used within <DevulturProvider> or <DevulturViewerProvider>");
	return context;
}

/**
 * The `api` passed to `<DevulturProvider>`: your app's exported Devultur functions. Under a `<DevulturViewerProvider>`
 * it throws a `DevulturCapabilityError`.
 */
export function useDevulturApi(): DevulturApi {
	const api = React.use(DevulturApiContext);
	if (api) return api;
	if (React.use(DevulturContext)) throw new DevulturCapabilityError("api");
	throw new Error("useDevulturApi must be used within <DevulturProvider>");
}

export function useDevulturProgress(): DevulturProgressContextValue {
	const context = React.use(DevulturProgressContext);
	if (!context) throw new Error("useDevulturProgress requires progress API in DevulturProvider");
	return context;
}
