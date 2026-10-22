// @vitest-environment jsdom

import type React from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIBRARY_API, paginated, record } from "./media-library-test-utils";
import type { UseMediaLibraryOptions } from "./use-media-library";

vi.mock("convex/react", async () => (await import("./media-library-test-utils")).convexReactMock());

const { DevulturProvider, useMediaLibrary } = await import("./react");

function renderLibrary(initialOptions: UseMediaLibraryOptions, api: object = LIBRARY_API) {
	const wrapper = ({ children }: { children: React.ReactNode }) => (
		<DevulturProvider api={api as never}>{children}</DevulturProvider>
	);
	return renderHook((options: UseMediaLibraryOptions) => useMediaLibrary(options), {
		wrapper,
		initialProps: initialOptions,
	});
}

const lastCall = () => paginated.calls.at(-1);

beforeEach(() => {
	paginated.reset();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useMediaLibrary", () => {
	it("lists the library newest first through listMediaPage, a page of pageSize at a time", () => {
		paginated.answer = () => ({ results: [record("a"), record("b")], status: "CanLoadMore" });

		const { result } = renderLibrary({ type: "image", pageSize: 12 });

		expect(lastCall()).toEqual({ reference: "listMediaPage", args: { type: "image" }, initialNumItems: 12 });
		expect(result.current.items.map((item) => item.key)).toEqual(["a", "b"]);
		expect(result.current).toMatchObject({ status: "CanLoadMore", isLoading: false, search: "" });
	});

	it("searches through searchMedia once the search has settled for 250 ms", () => {
		const { result, rerender } = renderLibrary({});

		rerender({ search: "co" });
		rerender({ search: "cov" });
		act(() => vi.advanceTimersByTime(200));
		rerender({ search: "cover " });
		act(() => vi.advanceTimersByTime(249));

		expect(paginated.calls.every((call) => call.reference === "listMediaPage")).toBe(true);
		expect(result.current.isSearchPending).toBe(true);

		act(() => vi.advanceTimersByTime(1));

		expect(lastCall()).toMatchObject({ reference: "searchMedia", args: { search: "cover" } });
		// "co" and "cov" were never queried.
		expect(new Set(paginated.calls.map((call) => JSON.stringify(call.args)))).toEqual(
			new Set([JSON.stringify({}), JSON.stringify({ search: "cover" })]),
		);
		expect(result.current).toMatchObject({ search: "cover", isSearchPending: false });
	});

	it("starts from an initial search without waiting, and applies a cleared search at once", () => {
		const { rerender } = renderLibrary({ search: "cover", type: "file" });
		expect(lastCall()).toMatchObject({ reference: "searchMedia", args: { search: "cover", type: "file" } });

		rerender({ search: "", type: "file" });

		expect(lastCall()).toMatchObject({ reference: "listMediaPage", args: { type: "file" } });
	});

	it("starts again from the first page when the query changes", () => {
		paginated.answer = (call) =>
			call.args.type === "video"
				? { results: [], status: "LoadingFirstPage" }
				: { results: [record("a")], status: "CanLoadMore" };
		const { result, rerender } = renderLibrary({ type: "image" });

		rerender({ type: "video" });

		// A new query (here, its args) makes Convex's `usePaginatedQuery` drop the loaded pages.
		expect(lastCall()).toMatchObject({ args: { type: "video" }, initialNumItems: 24 });
		expect(result.current).toMatchObject({ items: [], status: "LoadingFirstPage", isLoading: true });
	});

	it("loads pageSize more by default, or the count it's given", () => {
		const { result } = renderLibrary({ pageSize: 10 });

		result.current.loadMore();
		result.current.loadMore(5);

		expect(paginated.loadMore.mock.calls).toEqual([[10], [5]]);
	});

	it("names the function missing from the provider's api", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { searchMedia: _searchMedia, ...apiWithoutSearch } = LIBRARY_API;

		expect(() => renderLibrary({ search: "cover" }, apiWithoutSearch)).toThrow(
			"useMediaLibrary requires searchMedia in DevulturProvider api",
		);
	});

	it("throws the query's error, as usePaginatedQuery does", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		paginated.error = new Error("Not allowed");

		expect(() => renderLibrary({})).toThrow("Not allowed");
	});
});
