// Test doubles shared by the pdf.js preview tests. Not an entry point: never bundled.
import { act } from "@testing-library/react";
import { type Mock, vi } from "vitest";
import type { PdfjsModule, PdfRenderTask } from "./pdf-render";

export interface FakePdfjsOptions {
	pageCount?: number;
	/** Renders never settle, so unmounting has a task to cancel. */
	isRenderPending?: boolean;
	failure?: Error;
}

export interface FakePdfjs {
	pdfjs: PdfjsModule;
	getDocument: Mock<(source: { data: Uint8Array }) => unknown>;
	getPage: Mock<(pageNumber: number) => Promise<unknown>>;
	destroy: Mock<() => Promise<void>>;
	renderTasks: Array<PdfRenderTask & { cancel: Mock }>;
}

export function fakePdfjs({ pageCount = 3, isRenderPending = false, failure }: FakePdfjsOptions = {}): FakePdfjs {
	const renderTasks: Array<PdfRenderTask & { cancel: Mock }> = [];
	const destroy = vi.fn(async () => {});
	const getPage = vi.fn(async (pageNumber: number) => ({
		getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
		render: () => {
			const task = { promise: isRenderPending ? new Promise<void>(() => {}) : Promise.resolve(), cancel: vi.fn() };
			renderTasks.push(task);
			return task;
		},
		getTextContent: async () => ({ items: [{ str: `Text of page ${pageNumber}` }] }),
		cleanup: vi.fn(),
	}));
	const getDocument = vi.fn((_source: { data: Uint8Array }) => ({
		promise: failure ? Promise.reject(failure) : Promise.resolve({ numPages: pageCount, getPage }),
		destroy,
	}));
	const pdfjs: PdfjsModule = { GlobalWorkerOptions: { workerSrc: "" }, getDocument };
	return { pdfjs, getDocument, getPage, destroy, renderTasks };
}

// Records observers so a test decides when an element scrolls into view.
export function stubIntersectionObserver() {
	const observers: Array<{ callback: IntersectionObserverCallback; elements: Element[] }> = [];
	class FakeIntersectionObserver {
		private readonly record: { callback: IntersectionObserverCallback; elements: Element[] };
		constructor(callback: IntersectionObserverCallback) {
			this.record = { callback, elements: [] };
			observers.push(this.record);
		}
		observe(element: Element) {
			this.record.elements.push(element);
		}
		disconnect() {
			this.record.elements = [];
		}
	}
	vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
	const scrollIntoView = () =>
		act(() => {
			for (const { callback, elements } of observers) {
				const entries = elements.map((target) => ({ target, isIntersecting: true }));
				if (entries.length) callback(entries as never, {} as never);
			}
		});
	return { scrollIntoView };
}
