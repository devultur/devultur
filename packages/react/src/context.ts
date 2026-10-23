"use client";

import React from "react";
import type { ProgressContextValue, ProgressProviderProps } from "./types";

const ProgressContext = /* @__PURE__ */ React.createContext<ProgressContextValue | null>(null);

/**
 * Provides playback progress persistence callbacks to descendant hooks.
 */
export function ProgressProvider({ onSave, onLoad, onMarkComplete, onReset, children }: ProgressProviderProps) {
	const value = React.useMemo<ProgressContextValue>(
		() => ({
			save: onSave,
			load: onLoad,
			markComplete: onMarkComplete,
			reset: onReset,
		}),
		[onSave, onLoad, onMarkComplete, onReset],
	);

	return React.createElement(ProgressContext.Provider, { value }, children);
}

/**
 * Returns the progress persistence context, throwing if used outside a {@link ProgressProvider}.
 */
export function useProgressContext(): ProgressContextValue {
	const context = React.useContext(ProgressContext);

	if (!context) {
		throw new Error("useProgressContext must be used within a ProgressProvider");
	}

	return context;
}
