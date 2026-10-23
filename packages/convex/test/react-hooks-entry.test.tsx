// @vitest-environment jsdom

import type React from "react";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// `@devultur/convex/react` and `@devultur/convex/react/hooks` are two entries of the built package: a provider from one
// must fill the hooks of the other, so both must export the very same context objects (one shared chunk, which holds
// the contexts and the hooks that only read them, apart from the URL hooks).
const distDir = join(import.meta.dirname, "..", "dist");

type Entry = Record<string, unknown>;
let reactEntry: Entry = {};
let hooksEntry: Entry = {};

beforeAll(async () => {
	await access(join(distDir, "react", "hooks.js")).catch(() => {
		throw new Error("react-hooks-entry.test.tsx imports the built package: run `pnpm build` first");
	});
	reactEntry = await import(pathToFileURL(join(distDir, "react.js")).href);
	hooksEntry = await import(pathToFileURL(join(distDir, "react", "hooks.js")).href);
});

afterEach(cleanup);

describe("@devultur/convex/react/hooks", () => {
	it.each([
		"DevulturContext",
		"DevulturApiContext",
		"DevulturProgressContext",
	])("shares %s with the react entry", (name) => {
		expect(hooksEntry[name]).toBeDefined();
		expect(hooksEntry[name]).toBe(reactEntry[name]);
	});

	it.each([
		"useCanDeliver",
		"useDevultur",
		"useDevulturOptional",
		"useDevulturApi",
		"useDevulturProgress",
		"useMediaUrl",
		"useVideoProps",
	])("exports the same %s as the react entry", (name) => {
		expect(hooksEntry[name]).toBeTypeOf("function");
		expect(hooksEntry[name]).toBe(reactEntry[name]);
	});

	it("reads, from the hooks entry, the value a provider of the react entry gives", () => {
		const Context = reactEntry.DevulturContext as React.Context<{ baseUrl: string } | null>;
		const useDevulturOptional = hooksEntry.useDevulturOptional as () => { baseUrl: string } | null;
		function BaseUrl() {
			return <p>{useDevulturOptional()?.baseUrl ?? "outside"}</p>;
		}

		render(
			<Context value={{ baseUrl: "https://media.example.com" }}>
				<BaseUrl />
			</Context>,
		);

		expect(screen.getByText("https://media.example.com")).toBeDefined();
	});
});
