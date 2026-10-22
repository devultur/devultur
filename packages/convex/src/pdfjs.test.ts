import { describe, expect, it, vi } from "vitest";
import { fakePdfjs } from "./pdf-test-utils";

const globalWorkerOptions = vi.hoisted(() => ({ workerSrc: "" }));
const getDocument = vi.hoisted(() => vi.fn());
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ GlobalWorkerOptions: globalWorkerOptions, getDocument }));

const { countPdfPages, defaultPdfWorkerSrc, loadPdfjs } = await import("./pdfjs");

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

const pdfFile = () => new Blob(["%PDF-1.7 fake"], { type: "application/pdf" });

describe("countPdfPages", () => {
	it("counts the pages with the default pdf.js, imported on the first call, and frees the document", async () => {
		const fake = fakePdfjs({ pageCount: 12 });
		getDocument.mockImplementation(fake.getDocument);

		expect(await countPdfPages(pdfFile())).toBe(12);
		expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ enableScripting: false }));
		expect(fake.destroy).toHaveBeenCalledTimes(1);
	});

	it("uses the app's pdf.js loader when given one", async () => {
		const fake = fakePdfjs({ pageCount: 4 });

		expect(await countPdfPages(pdfFile(), { loadPdfjs: async () => fake.pdfjs })).toBe(4);
		expect(fake.getDocument).toHaveBeenCalledTimes(1);
	});

	it("is null for a file pdf.js can't open, and still frees it", async () => {
		const fake = fakePdfjs({ failure: new Error("Invalid PDF structure") });

		expect(await countPdfPages(new Blob(["not a pdf"]), { loadPdfjs: async () => fake.pdfjs })).toBeNull();
		expect(fake.destroy).toHaveBeenCalledTimes(1);
	});
});
