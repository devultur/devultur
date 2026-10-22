// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paginated } from "./media-library-test-utils";
import {
	actions,
	announced,
	BASE_URL,
	chooseFiles,
	DrivenXhr,
	flush,
	PICKER_API,
	pdf,
	resetPickerMocks,
} from "./media-picker-test-utils";
import { fakePdfjs } from "./pdf-test-utils";
import type { MediaPickerProps } from "./react";

vi.mock("convex/react", async () => (await import("./media-picker-test-utils")).pickerConvexMock());

const { DevulturProvider, MediaPicker, PdfPreviewProvider } = await import("./react");

function renderPicker(props: Partial<MediaPickerProps> = {}) {
	const onChange = vi.fn();
	render(
		<DevulturProvider api={PICKER_API as never} baseUrl={BASE_URL}>
			<MediaPicker onChange={onChange} {...(props as object)} />
		</DevulturProvider>,
	);
	return { onChange };
}

const uploadsList = () => screen.getByRole("list", { name: "Uploads" });
const selection = () => screen.getByRole("region", { name: "Selected media" });

beforeEach(() => {
	paginated.reset();
	resetPickerMocks();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("<MediaPicker> uploads", () => {
	it("shows a file's progress, then selects it, focuses the selection and announces it", async () => {
		const { onChange } = renderPicker();
		await chooseFiles(pdf());

		const xhr = DrivenXhr.sent[0]!;
		expect(announced()).toBe("Uploading report.pdf.");
		act(() => xhr.progress(0.5));
		const progress = within(uploadsList()).getByRole("progressbar", { name: "Uploading report.pdf" });
		expect(progress.getAttribute("value")).toBe("50");
		expect(within(uploadsList()).getByText("50%")).toBeTruthy();

		act(() => xhr.finish());
		await flush();

		expect(screen.queryByRole("list", { name: "Uploads" })).toBeNull();
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "id-report.pdf",
				kind: "file",
				key: "public/file/id-report.pdf/report.pdf",
				filename: "report.pdf",
				sizeBytes: pdf().size,
			}),
		);
		expect(within(selection()).getByRole("heading", { name: "report.pdf" })).toBeTruthy();
		expect(document.activeElement).toBe(selection());
		expect(announced()).toBe("report.pdf uploaded and selected.");
	});

	it("cancels an upload: aborts the PUT, drops it and selects nothing", async () => {
		const { onChange } = renderPicker();
		await chooseFiles(pdf());

		fireEvent.click(screen.getByRole("button", { name: "Cancel uploading report.pdf" }));
		await flush();

		expect(DrivenXhr.sent[0]?.isAborted).toBe(true);
		expect(screen.queryByRole("list", { name: "Uploads" })).toBeNull();
		expect(announced()).toBe("Upload of report.pdf cancelled.");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("shows a refusal's message and retries the same file", async () => {
		const refusal = new ConvexError({ code: "file_too_large", message: "x", status: 413, details: { limit: 5e6 } });
		actions.set("createUploadUrl", async () => {
			throw refusal;
		});
		const { onChange } = renderPicker();
		await chooseFiles(pdf());

		expect(within(uploadsList()).getByRole("alert").textContent).toBe("The file exceeds the maximum size (5 MB).");

		actions.set("createUploadUrl", async () => ({
			url: "https://uploads.example/x",
			key: "public/file/x/report.pdf",
			id: "x",
			kind: "file",
			visibility: "public",
		}));
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await flush();
		act(() => DrivenXhr.sent[0]?.finish());
		await flush();

		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "x" }));
	});

	it("reports a failed PUT and lets the editor dismiss it", async () => {
		renderPicker();
		await chooseFiles(pdf());
		act(() => DrivenXhr.sent[0]?.finish(500));
		await flush();

		expect(within(uploadsList()).getByRole("alert").textContent).toBe("The upload failed. Try again.");
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("list", { name: "Uploads" })).toBeNull();
	});

	it("turns away a file `accept` doesn't let through, without uploading it", async () => {
		const createUploadUrl = vi.fn(async () => null);
		actions.set("createUploadUrl", createUploadUrl);
		renderPicker({ accept: ["image/*"] });

		expect(document.querySelector("input[type='file']")?.getAttribute("accept")).toBe("image/*");
		await chooseFiles(pdf());

		expect(within(uploadsList()).getByRole("alert").textContent).toBe(
			"report.pdf isn't a file type you can pick here.",
		);
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		expect(createUploadUrl).not.toHaveBeenCalled();
	});

	it("uploads several files with `multiple` and adds each to the selection", async () => {
		const { onChange } = renderPicker({ multiple: true, value: undefined });
		await chooseFiles(pdf("a.pdf"), pdf("b.pdf"));

		expect(within(uploadsList()).getAllByRole("progressbar")).toHaveLength(2);
		act(() => DrivenXhr.sent[1]?.finish());
		await flush();
		act(() => DrivenXhr.sent[0]?.finish());
		await flush();

		const lastValue = onChange.mock.lastCall?.[0] as Array<{ id: string }>;
		expect(lastValue.map((media) => media.id)).toEqual(["id-b.pdf", "id-a.pdf"]);
	});

	it("uploads only the first file without `multiple`", async () => {
		renderPicker();
		await chooseFiles(pdf("a.pdf"), pdf("b.pdf"));

		expect(DrivenXhr.sent).toHaveLength(1);
	});

	it("records a PDF's page count when a PdfPreviewProvider has pdf.js", async () => {
		const confirmUpload = vi.fn(async (_args: Record<string, unknown>) => null);
		actions.set("confirmUpload", confirmUpload);
		const fake = fakePdfjs({ pageCount: 7 });
		const onChange = vi.fn();
		render(
			<DevulturProvider api={PICKER_API as never} baseUrl={BASE_URL}>
				<PdfPreviewProvider pdfjs={async () => fake.pdfjs}>
					<MediaPicker onChange={onChange} />
				</PdfPreviewProvider>
			</DevulturProvider>,
		);
		await chooseFiles(pdf());
		await flush();
		act(() => DrivenXhr.sent[0]?.finish());
		await flush();

		expect(confirmUpload).toHaveBeenCalledWith(expect.objectContaining({ pageCount: 7 }));
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pageCount: 7 }));
		expect(within(selection()).getByText(/7 pages/)).toBeTruthy();
	});

	it("asks for no upload URL when cancelled while a PDF's pages are counted", async () => {
		const createUploadUrl = vi.fn(async () => ({}));
		actions.set("createUploadUrl", createUploadUrl);
		const fake = fakePdfjs({ pageCount: 7 });
		let finishCounting: () => void = () => {};
		const counting = new Promise<void>((resolve) => (finishCounting = resolve));
		const slowPdfjs = {
			...fake.pdfjs,
			getDocument: (source: { data: Uint8Array }) => {
				const task = fake.pdfjs.getDocument(source as never) as { promise: Promise<unknown>; destroy: () => void };
				return { ...task, promise: counting.then(() => task.promise) };
			},
		};
		render(
			<DevulturProvider api={PICKER_API as never} baseUrl={BASE_URL}>
				<PdfPreviewProvider pdfjs={async () => slowPdfjs as never}>
					<MediaPicker onChange={vi.fn()} />
				</PdfPreviewProvider>
			</DevulturProvider>,
		);
		await chooseFiles(pdf());
		await flush();

		fireEvent.click(screen.getByRole("button", { name: "Cancel uploading report.pdf" }));
		finishCounting();
		await flush();
		await flush();

		expect(createUploadUrl).not.toHaveBeenCalled();
		expect(DrivenXhr.sent).toHaveLength(0);
		expect(announced()).toBe("Upload of report.pdf cancelled.");
	});
});
