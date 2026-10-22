// @vitest-environment jsdom

import type { DevulturMedia } from "@devultur/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paginated, record } from "./media-library-test-utils";
import { defaultMediaPickerLabels } from "./media-picker-labels";
import { announced, BASE_URL, chooseFiles, PICKER_API, pdf, resetPickerMocks } from "./media-picker-test-utils";
import type { MediaPickerProps } from "./react";

vi.mock("convex/react", async () => (await import("./media-picker-test-utils")).pickerConvexMock());

const { DevulturProvider, MediaPicker, useMediaPicker } = await import("./react");
const es = await import("./locales/es");

const RECORDS = [
	record("photo", {
		type: "image",
		filename: "beach.png",
		title: "Beach",
		alt: "A beach",
		contentType: "image/png",
		objectKey: "public/image/photo/beach.png",
	}),
	record("report", {
		filename: "report.pdf",
		contentType: "application/pdf",
		objectKey: "public/file/report/report.pdf",
	}),
	record("notes", { objectKey: "public/file/notes/notes.txt" }),
];

const NOTES: DevulturMedia = { id: "notes", kind: "file", visibility: "public", filename: "notes.txt" };

function picker(props: Partial<MediaPickerProps> = {}) {
	return (
		<DevulturProvider api={PICKER_API as never} baseUrl={BASE_URL}>
			<MediaPicker onChange={() => {}} {...(props as object)} />
		</DevulturProvider>
	);
}

const option = (name: string) => within(screen.getByRole("listbox")).getByRole("option", { name: new RegExp(name) });
const selection = () => screen.getByRole("region", { name: "Selected media" });
const selectedNames = () =>
	within(selection())
		.queryAllByRole("article")
		.map((card) => within(card).getByRole("heading").textContent);

beforeEach(() => {
	paginated.reset();
	paginated.answer = () => ({ results: RECORDS, status: "Exhausted" });
	resetPickerMocks();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("<MediaPicker> selection", () => {
	it("selects from the library: the record's reference, with its title and metadata", () => {
		const onChange = vi.fn();
		render(picker({ onChange }));

		fireEvent.click(option("Beach"));

		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "photo",
				kind: "image",
				title: "Beach",
				alt: "A beach",
				key: "public/image/photo/beach.png",
			}),
		);
		expect(selectedNames()).toEqual(["Beach"]);
		expect(option("Beach").getAttribute("aria-selected")).toBe("true");
		expect(announced()).toBe("Beach selected.");
	});

	it("shows the controlled value, and leaves changing it to the app", () => {
		const onChange = vi.fn();
		const { rerender } = render(picker({ value: NOTES, onChange }));

		expect(selectedNames()).toEqual(["notes.txt"]);
		expect(option("notes").getAttribute("aria-selected")).toBe("true");

		fireEvent.click(option("Beach"));
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "photo" }));
		expect(selectedNames()).toEqual(["notes.txt"]);

		rerender(picker({ value: null, onChange }));
		expect(selectedNames()).toEqual([]);
		expect(within(selection()).getByText("Nothing selected.")).toBeTruthy();
	});

	it("clears and removes, moving focus to the selection", () => {
		const onChange = vi.fn();
		render(picker({ multiple: true, onChange }));
		fireEvent.click(option("Beach"));
		fireEvent.click(option("report"));
		expect(selectedNames()).toEqual(["Beach", "report.pdf"]);

		fireEvent.click(screen.getByRole("button", { name: "Remove Beach" }));
		expect(selectedNames()).toEqual(["report.pdf"]);
		expect(document.activeElement).toBe(selection());
		expect(announced()).toBe("Beach removed.");

		fireEvent.click(screen.getByRole("button", { name: "Clear" }));
		expect(onChange).toHaveBeenLastCalledWith([]);
		expect(announced()).toBe("Selection cleared.");
	});

	it("toggles items with `multiple`, and replaces the item without it", () => {
		const onChange = vi.fn();
		const { unmount } = render(picker({ multiple: true, onChange }));
		expect(screen.getByRole("listbox").getAttribute("aria-multiselectable")).toBe("true");

		fireEvent.click(option("Beach"));
		fireEvent.click(option("notes"));
		fireEvent.click(option("Beach"));
		expect(onChange.mock.lastCall?.[0].map((media: DevulturMedia) => media.id)).toEqual(["notes"]);
		unmount();

		render(picker({ onChange }));
		fireEvent.click(option("Beach"));
		fireEvent.click(option("notes"));
		expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: "notes" }));
		expect(selectedNames()).toEqual(["notes.txt"]);
		expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
	});

	it("filters the library by `accept`: its type, and records that don't match", () => {
		render(picker({ accept: ["application/pdf"] }));

		expect(paginated.calls.at(-1)?.args).toEqual({ type: "file" });
		expect(screen.queryByRole("combobox", { name: "Type" })).toBeNull();
		expect(
			within(screen.getByRole("listbox"))
				.getAllByRole("option")
				.map((item) => item.textContent),
		).toEqual(["report.pdf2 kB"]);
	});

	it("gives `type` to the library and the upload", () => {
		render(picker({ type: "image" }));

		expect(paginated.calls.at(-1)?.args).toEqual({ type: "image" });
		expect(document.querySelector("input[type='file']")?.getAttribute("accept")).toBe("image/*");
	});

	it("previews a selected item inline", () => {
		render(picker({ value: NOTES }));

		fireEvent.click(within(selection()).getByRole("button", { name: "Open preview" }));
		expect(within(selection()).getByRole("status")).toBeTruthy();
	});
});

describe("<MediaPicker> composition", () => {
	it("lays out the parts the app chooses, and gives a render prop the state", async () => {
		const states: number[] = [];
		function Count() {
			return <p>{useMediaPicker().selected.length} picked</p>;
		}
		render(
			<DevulturProvider api={PICKER_API as never} baseUrl={BASE_URL}>
				<MediaPicker onChange={() => {}} value={NOTES}>
					{(state) => {
						states.push(state.selected.length);
						return (
							<>
								<MediaPicker.Upload />
								<Count />
							</>
						);
					}}
				</MediaPicker>
			</DevulturProvider>,
		);

		expect(screen.queryByRole("listbox")).toBeNull();
		expect(screen.getByText("1 picked")).toBeTruthy();
		expect(states.at(-1)).toBe(1);
		expect(screen.getByRole("button", { name: "Upload a file" })).toBeTruthy();
	});
});

describe("<MediaPicker> Spanish labels", () => {
	it("label every string the English defaults have", () => {
		expect(Object.keys(es.mediaPickerLabels).sort()).toEqual(Object.keys(defaultMediaPickerLabels).sort());
	});

	it("shows the Spanish strings and errors", async () => {
		render(
			picker({
				multiple: true,
				accept: ["image/*"],
				labels: es.mediaPickerLabels,
				libraryLabels: es.mediaLibraryLabels,
			}),
		);

		expect(screen.getByRole("button", { name: "Subir archivos" })).toBeTruthy();
		expect(screen.getByRole("listbox", { name: "Archivos" })).toBeTruthy();
		expect(screen.getByRole("region", { name: "Archivos seleccionados" })).toBeTruthy();
		await chooseFiles(pdf());
		expect(screen.getByRole("alert").textContent).toBe("report.pdf no es un tipo de archivo que se pueda elegir aquí.");
		expect(es.mediaPickerLabels.uploadError(new Error("network"))).toBe("La subida falló. Vuelve a intentarlo.");
	});
});
