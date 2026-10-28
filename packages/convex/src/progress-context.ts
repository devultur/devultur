"use client";

// The watch-progress functions `<DevulturProvider>` fills when its `api` has them. `useDevulturProgress` reads them
// (`provider-hooks.ts`).
import React from "react";

export interface DevulturProgressContextValue {
	save: (videoId: string, position: number) => Promise<void>;
	load: (videoId: string) => Promise<{ lastPosition: number; completedAt: Date | null } | null>;
	markComplete: (videoId: string) => Promise<void>;
	reset: (videoId: string) => Promise<void>;
}

export const DevulturProgressContext = /* @__PURE__ */ React.createContext<DevulturProgressContextValue | null>(null);
