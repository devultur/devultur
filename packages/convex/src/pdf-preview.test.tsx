// @vitest-environment jsdom

import type React from "react";
import type { DevulturMedia } from "@devultur/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfjsLoader } from "./pdf-render";
import { fakePdfjs, stubIntersectionObserver } from "./pdf-test-utils";

vi.mock("convex/react", () => ({
	useAction: () => async () => ({ token: "viewer-token", expiresIn: 3600 }),
	useMutation: () => vi.fn(),
	useQuery: () => undefined,
	useConvex: () => ({}),
}));

const { DevulturProvider, PdfPreviewProvider, PdfThumbnail, Preview } = await import("./react");

const BASE_URL = "https://media.example";
const api = { issueViewerToken: "issueViewerToken", createUploadUrl: "createUploadUrl", deleteMedia: "deleteMedia" };
const PDF_BODY = "%PDF-1.7 test";

const privateFile = (filename: string): DevulturMedia => ({ id: "f1", kind: "file", visibility: "private", filename });

function renderWithPdfjs(element: React.ReactElement, loader?: PdfjsLoader) {
	return render(
		<DevulturProvider api={api as never} baseUrl={BASE_URL}>
			<PdfPreviewProvider pdfjs={loader}>{element}</PdfPreviewProvider>
		</DevulturProvider>,
	);
}

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

beforeEach(() => {
	fetchMock = vi.fn(async () => new Response(PDF_BODY, { headers: { "Content-Type": "application/pdf" } }));
	vi.stubGlobal("fetch", fetchMock);
	Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() });
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("<Preview> with pdf.js", () => {
	it("renders every page on a canvas from the fetched bytes, with scripting off", async () => {
		const fake = fakePdfjs();
		const { container } = renderWithPdfjs(
			<Preview media={privateFile("tax-form.pdf")} title="Tax form" />,
			async () => fake.pdfjs,
		);

		await screen.findByRole("document", { name: "Tax form, 3 pages" });
		await waitFor(() => expect(container.querySelectorAll("canvas")).toHaveLength(3));
		expect(container.querySelector("iframe")).toBeNull();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
		expect(fake.getDocument).toHaveBeenCalledTimes(1);
		expect(fake.getDocument.mock.calls[0]![0]).toMatchObject({ enableScripting: false, isEvalSupported: false });
		expect(await screen.findByText("Text of page 2")).toBeTruthy();
	});

	it("never hands pdf.js a URL: only the bytes of the single verified fetch", async () => {
		const fake = fakePdfjs({ pageCount: 1 });
		renderWithPdfjs(<Preview media={privateFile("contract.pdf")} />, async () => fake.pdfjs);

		await waitFor(() => expect(fake.getDocument).toHaveBeenCalled());
		const source = fake.getDocument.mock.calls[0]![0] as Record<string, unknown>;
		expect(Object.keys(source).sort()).toEqual(["data", "enableScripting", "isEvalSupported"]);
		expect(new TextDecoder().decode(source.data as Uint8Array)).toBe(PDF_BODY);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("falls back to the <iframe> when pdf.js can't be imported, without a second fetch", async () => {
		const { container } = renderWithPdfjs(<Preview media={privateFile("tax-form.pdf")} />, () =>
			Promise.reject(new Error("Cannot find module 'pdfjs-dist'")),
		);

		await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
		expect(container.querySelector("iframe")!.getAttribute("src")).toBe("blob:preview");
		expect((vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob).type).toBe("application/pdf");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("renders the fallback when pdf.js can't parse the body", async () => {
		const fake = fakePdfjs({ failure: new Error("Invalid PDF structure") });
		renderWithPdfjs(<Preview media={privateFile("broken.pdf")} fallback={<p>Download</p>} />, async () => fake.pdfjs);

		expect(await screen.findByText("Download")).toBeTruthy();
	});

	it("hands render_failed to a fallback function when pdf.js can't parse the body", async () => {
		const fake = fakePdfjs({ failure: new Error("Invalid PDF structure") });
		renderWithPdfjs(
			<Preview media={privateFile("broken.pdf")} fallback={(error) => <p>Fallback: {error.code}</p>} />,
			async () => fake.pdfjs,
		);

		expect(await screen.findByText("Fallback: render_failed")).toBeTruthy();
	});

	it("hands page_cap with the counts to a fallback function past the cap", async () => {
		const fake = fakePdfjs({ pageCount: 10, isRenderPending: true });
		renderWithPdfjs(
			<Preview
				media={privateFile("long.pdf")}
				maxPages={3}
				fallback={(error) => <a href="#download">{`${error.code} ${JSON.stringify(error.details)}`}</a>}
			/>,
			async () => fake.pdfjs,
		);

		expect(await screen.findByText('page_cap {"shown":3,"total":10}')).toBeTruthy();
	});

	it("titles the default fallback's link past the cap", async () => {
		const fake = fakePdfjs({ pageCount: 10, isRenderPending: true });
		renderWithPdfjs(<Preview media={privateFile("long.pdf")} maxPages={3} />, async () => fake.pdfjs);

		const link = await screen.findByText("long.pdf");
		expect(link.closest("a")?.getAttribute("title")).toBe("Download the file to see every page.");
	});

	it("destroys the document and cancels page renders on unmount", async () => {
		const fake = fakePdfjs({ pageCount: 2, isRenderPending: true });
		const { unmount } = renderWithPdfjs(<Preview media={privateFile("tax-form.pdf")} />, async () => fake.pdfjs);

		await waitFor(() => expect(fake.renderTasks).toHaveLength(2));
		unmount();

		expect(fake.destroy).toHaveBeenCalled();
		for (const task of fake.renderTasks) expect(task.cancel).toHaveBeenCalled();
	});

	it("caps the rendered pages and offers the fallback past the cap", async () => {
		const fake = fakePdfjs({ pageCount: 10_000_000 });
		const { container } = renderWithPdfjs(
			<Preview media={privateFile("bomb.pdf")} maxPages={3} fallback={<a href="#download">Download</a>} />,
			async () => fake.pdfjs,
		);

		expect(await screen.findByText(/Showing the first 3 of 10000000 pages/)).toBeTruthy();
		expect(container.querySelectorAll("section")).toHaveLength(3);
		expect(screen.getByText("Download")).toBeTruthy();
	});

	it("caps at 500 pages by default", async () => {
		const fake = fakePdfjs({ pageCount: 10_000_000, isRenderPending: true });
		const { container } = renderWithPdfjs(<Preview media={privateFile("bomb.pdf")} />, async () => fake.pdfjs);

		expect(await screen.findByText(/Showing the first 500 of 10000000 pages/)).toBeTruthy();
		expect(container.querySelectorAll("section")).toHaveLength(500);
	});

	it("sets the worker from pdfWorkerSrc before opening the document", async () => {
		const fake = fakePdfjs({ pageCount: 1 });
		renderWithPdfjs(
			<Preview media={privateFile("tax-form.pdf")} pdfWorkerSrc="/assets/pdf.worker.min.mjs" />,
			async () => fake.pdfjs,
		);

		await waitFor(() => expect(fake.getDocument).toHaveBeenCalled());
		expect(fake.pdfjs.GlobalWorkerOptions.workerSrc).toBe("/assets/pdf.worker.min.mjs");
	});
});

describe("<PdfThumbnail>", () => {
	it("fetches nothing until visible, then renders page 1 only", async () => {
		const { scrollIntoView } = stubIntersectionObserver();
		const fake = fakePdfjs({ pageCount: 5 });
		renderWithPdfjs(<PdfThumbnail media={privateFile("invoice.pdf")} width={64} />, async () => fake.pdfjs);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fetchMock).not.toHaveBeenCalled();

		scrollIntoView();

		const thumbnail = await screen.findByRole("img", { name: "invoice.pdf" });
		await waitFor(() => expect(fake.renderTasks).toHaveLength(1));
		expect(fake.getPage.mock.calls).toEqual([[1]]);
		expect((thumbnail as HTMLCanvasElement).style.width).toBe("64px");
	});

	it("renders the fallback without pdf.js, and never fetches", async () => {
		renderWithPdfjs(<PdfThumbnail media={privateFile("invoice.pdf")} fallback={<span>PDF</span>} />);

		expect(await screen.findByText("PDF")).toBeTruthy();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("renders the fallback for media that isn't a PDF", async () => {
		const fake = fakePdfjs();
		renderWithPdfjs(
			<PdfThumbnail media={privateFile("photo.png")} fallback={<span>Not a PDF</span>} />,
			async () => fake.pdfjs,
		);

		expect(await screen.findByText("Not a PDF")).toBeTruthy();
		expect(fake.getDocument).not.toHaveBeenCalled();
	});
});
