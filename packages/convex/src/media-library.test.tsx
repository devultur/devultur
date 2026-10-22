// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIBRARY_API, paginated, record } from "./media-library-test-utils";
import type { MediaLibraryLabels, MediaLibraryProps } from "./react";

vi.mock("convex/react", async () => (await import("./media-library-test-utils")).convexReactMock());

const { DevulturProvider, MediaLibrary, PdfPreviewProvider } = await import("./react");

const BASE_URL = "https://media.example";
const RECORDS = [
	record("photo", {
		type: "image",
		filename: "beach.png",
		title: "Beach",
		contentType: "image/png",
		objectKey: "public/image/photo/beach.png",
	}),
	record("report", { filename: "report.pdf", contentType: "application/pdf", sizeBytes: 1_500_000 }),
	record("notes"),
	record("intro", { type: "video", filename: "intro.mp4", contentType: "video/mp4", sizeBytes: 0 }),
];

function renderLibrary(props: Partial<MediaLibraryProps> = {}) {
	const onSelect = vi.fn();
	render(
		<DevulturProvider api={LIBRARY_API as never} baseUrl={BASE_URL}>
			<MediaLibrary onSelect={onSelect} {...props} />
		</DevulturProvider>,
	);
	return { onSelect };
}

const options = () => within(screen.getByRole("listbox")).getAllByRole("option");
const focused = () => document.activeElement?.textContent;

beforeEach(() => {
	paginated.reset();
	paginated.answer = () => ({ results: RECORDS, status: "CanLoadMore" });
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("<MediaLibrary>", () => {
	it("shows each record's thumbnail or icon, name and size", () => {
		renderLibrary();

		expect(screen.getByRole("listbox", { name: "Media" })).toBeTruthy();
		expect(options().map((option) => option.textContent)).toEqual([
			"Beach2 kB",
			"report.pdf1.5 MB",
			"notes.txt2 kB",
			"intro.mp4",
		]);
		const thumbnail = options()[0]?.querySelector("img");
		const srcSet = thumbnail?.getAttribute("srcset") ?? "";
		expect(srcSet).toMatch(/w=160[^ ]*format=auto/);
		expect(srcSet).toContain(" 160w");
		expect(srcSet).toContain(" 320w");
		expect(thumbnail?.getAttribute("sizes")).toBe("160px");
		expect(options()[1]?.querySelector("[data-kind='pdf']")).toBeTruthy();
		expect(options()[1]?.querySelector("div[style*='width: 160px']")).toBeNull();
	});

	it("draws PDF thumbnails only when the app opts in", () => {
		render(
			<DevulturProvider api={LIBRARY_API as never} baseUrl={BASE_URL}>
				<PdfPreviewProvider>
					<MediaLibrary onSelect={() => {}} pdfThumbnails />
				</PdfPreviewProvider>
			</DevulturProvider>,
		);
		// Off-screen (no IntersectionObserver here), `<PdfThumbnail>` waits in its sized box instead of the icon alone.
		expect(options()[1]?.querySelector("div[style*='width: 160px']")).toBeTruthy();
	});

	it("moves a single tab stop with the arrow keys, Home and End", () => {
		renderLibrary();
		const [first] = options();
		expect(options().map((option) => option.tabIndex)).toEqual([0, -1, -1, -1]);

		first?.focus();
		fireEvent.keyDown(first as Element, { key: "ArrowRight" });
		expect(focused()).toBe("report.pdf1.5 MB");
		fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
		expect(focused()).toBe("notes.txt2 kB");
		fireEvent.keyDown(document.activeElement as Element, { key: "End" });
		expect(focused()).toBe("intro.mp4");
		fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
		expect(focused()).toBe("intro.mp4");
		fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
		expect(focused()).toBe("Beach2 kB");

		fireEvent.keyDown(document.activeElement as Element, { key: "End" });
		expect(options().map((option) => option.tabIndex)).toEqual([-1, -1, -1, 0]);
	});

	it("calls onSelect with the record and its reference on Enter, Space or a click", () => {
		const { onSelect } = renderLibrary();

		fireEvent.keyDown(options()[1] as Element, { key: "Enter" });
		fireEvent.keyDown(options()[2] as Element, { key: " " });
		fireEvent.click(options()[0] as Element);

		expect(onSelect.mock.calls.map(([chosen]) => chosen.key)).toEqual(["report", "notes", "photo"]);
		expect(onSelect.mock.calls[2]?.[1]).toMatchObject({ id: "photo", kind: "image", visibility: "public" });
		expect(options().every((option) => option.getAttribute("aria-selected") === "false")).toBe(true);
	});

	it("keeps the chosen item selected when selectable", () => {
		renderLibrary({ selectable: true });

		fireEvent.click(options()[2] as Element);

		expect(options().map((option) => option.getAttribute("aria-selected"))).toEqual([
			"false",
			"false",
			"true",
			"false",
		]);
	});

	it("searches what is typed once it settles, and filters by type", () => {
		vi.useFakeTimers();
		renderLibrary();

		fireEvent.change(screen.getByRole("searchbox", { name: "Search media" }), { target: { value: "report" } });
		act(() => vi.advanceTimersByTime(250));
		expect(paginated.calls.at(-1)).toMatchObject({ reference: "searchMedia", args: { search: "report" } });

		fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "file" } });
		expect(paginated.calls.at(-1)).toMatchObject({ args: { search: "report", type: "file" } });
	});

	it("hides the type filter when the app fixes the type", () => {
		renderLibrary({ type: "image" });
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(paginated.calls.at(-1)?.args).toEqual({ type: "image" });
	});

	it("loads more on request, and shows when it is loading them", () => {
		renderLibrary();
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(paginated.loadMore).toHaveBeenCalledWith(24);

		cleanup();
		paginated.answer = () => ({ results: RECORDS, status: "LoadingMore" });
		renderLibrary();
		expect(screen.getByRole("button", { name: "Loading…" }).hasAttribute("disabled")).toBe(true);
		expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");
	});

	it("shows the loading, empty and no-match states", () => {
		paginated.answer = () => ({ results: [], status: "LoadingFirstPage" });
		renderLibrary();
		expect(screen.getByRole("status").textContent).toBe("Loading media…");

		cleanup();
		paginated.answer = () => ({ results: [], status: "Exhausted" });
		renderLibrary();
		expect(screen.getByRole("status").textContent).toBe("No media yet.");

		vi.useFakeTimers();
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zebra" } });
		act(() => vi.advanceTimersByTime(250));
		expect(screen.getByRole("status").textContent).toBe("Nothing matches “zebra”.");
	});

	it("shows a failed query in place of the items, with a retry", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		paginated.error = new Error("Not allowed");
		renderLibrary({ labels: { error: (error) => `Failed: ${(error as Error).message}` } });

		expect(screen.getByRole("alert").textContent).toContain("Failed: Not allowed");

		paginated.error = null;
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));

		expect(screen.queryByRole("alert")).toBeNull();
		expect(options()).toHaveLength(4);
	});

	it("uses the English error message by default", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		paginated.error = new Error("boom");
		renderLibrary();
		expect(screen.getByRole("alert").textContent).toContain("The media couldn't be loaded.");
	});

	it("shows the app's labels over the English defaults", () => {
		const spanish: Partial<MediaLibraryLabels> = {
			search: "Buscar archivos",
			typeFilter: "Tipo",
			allTypes: "Todos",
			types: { image: "Imágenes", video: "Videos", file: "Archivos" },
			results: "Archivos",
			loadMore: "Cargar más",
			size: (bytes) => `${bytes} bytes`,
		};
		renderLibrary({ labels: spanish });

		expect(screen.getByRole("searchbox", { name: "Buscar archivos" })).toBeTruthy();
		expect(screen.getByRole("option", { name: "Imágenes" })).toBeTruthy();
		expect(screen.getByRole("listbox", { name: "Archivos" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Cargar más" })).toBeTruthy();
		expect(options()[2]?.textContent).toBe("notes.txt2048 bytes");
		expect(screen.getByRole("searchbox").getAttribute("placeholder")).toBe("Search by title or filename");
	});

	it("renders the app's item content, keeping the option around it", () => {
		renderLibrary({
			selectable: true,
			renderItem: (item, state) => `${item.key}:${state.media ? "ref" : "none"}:${state.isActive}`,
		});
		expect(options().map((option) => option.textContent)).toEqual([
			"photo:ref:true",
			"report:ref:false",
			"notes:ref:false",
			"intro:ref:false",
		]);
	});

	it("adds the app's class names to each part's own", () => {
		renderLibrary({ className: "picker", classNames: { item: "tile" } });
		expect(document.querySelector(".devultur-media-library.picker")).toBeTruthy();
		expect(options()[0]?.className).toBe("devultur-media-library__item tile");
	});
});
