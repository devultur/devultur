import { describe, expect, it, vi } from "vitest";

const globalWorkerOptions = vi.hoisted(() => ({ workerSrc: "" }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ GlobalWorkerOptions: globalWorkerOptions, getDocument: vi.fn() }));

const { defaultPdfWorkerSrc, loadPdfjs } = await import("./pdfjs");

describe("loadPdfjs", () => {
	it("imports the legacy build and points the worker at the legacy worker", async () => {
		const pdfjs = await loadPdfjs();

		expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe(defaultPdfWorkerSrc());
		expect(defaultPdfWorkerSrc()).toMatch(/pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs$/);
	});

	it("keeps a worker the app already set", async () => {
		globalWorkerOptions.workerSrc = "/static/pdf.worker.min.mjs";
		const pdfjs = await loadPdfjs();

		expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe("/static/pdf.worker.min.mjs");
	});
});
