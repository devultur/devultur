"use client";

// The watch-progress functions `<DevulturProvider>` fills when its `api` has them, and the hook that reads them.
import React from "react";

export interface DevulturProgressContextValue {
	save: (videoId: string, position: number) => Promise<void>;
	load: (videoId: string) => Promise<{ lastPosition: number; completedAt: Date | null } | null>;
	markComplete: (videoId: string) => Promise<void>;
	reset: (videoId: string) => Promise<void>;
}

export const DevulturProgressContext = /* @__PURE__ */ React.createContext<DevulturProgressContextValue | null>(null);

export function useDevulturProgress(): DevulturProgressContextValue {
	const context = React.use(DevulturProgressContext);
	if (!context) throw new Error("useDevulturProgress requires progress API in DevulturProvider");
	return context;
}
