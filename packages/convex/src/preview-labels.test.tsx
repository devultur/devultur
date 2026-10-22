// @vitest-environment jsdom

import type React from "react";
import type { DevulturMedia } from "@devultur/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfjsLoader } from "./pdf-render";
import { fakePdfjs, stubIntersectionObserver } from "./pdf-test-utils";
import type { PreviewLabels } from "./preview-labels";

vi.mock("convex/react", () => ({
	useAction: () => async () => ({ token: "viewer-token", expiresIn: 3600 }),
	useMutation: () => vi.fn(),
	useQuery: () => undefined,
	useConvex: () => ({}),
}));

const { DevulturProvider, MediaFetchError, PdfPreviewProvider, PdfThumbnail, Preview } = await import("./react");

const BASE_URL = "https://media.example";
const api = { issueViewerToken: "issueViewerToken", createUploadUrl: "createUploadUrl", deleteMedia: "deleteMedia" };

const privateFile = (filename: string): DevulturMedia => ({ id: "f1", kind: "file", visibility: "private", filename });

const spanishLabels: Partial<PreviewLabels> = {
	document: (title, pageCount) => `${title}, ${pageCount} páginas`,
	page: (page, pageCount) => `Página ${page} de ${pageCount}`,
	loading: "Cargando…",
	pageCap: (shown, total) => `Mostrando las primeras ${shown} de ${total} páginas.`,
	error: (code) => (code === "too_large" ? "El archivo es demasiado grande." : "No se puede previsualizar."),
	thumbnail: (title) => `Miniatura de ${title}`,
};

interface RenderOptions {
	loader?: PdfjsLoader;
	providerLabels?: Partial<PreviewLabels>;
}

function renderPreview(element: React.ReactElement, { loader, providerLabels }: RenderOptions = {}) {
	return render(
		<DevulturProvider api={api as never} baseUrl={BASE_URL}>
			<PdfPreviewProvider pdfjs={loader} labels={providerLabels}>
				{element}
			</PdfPreviewProvider>
		</DevulturProvider>,
	);
}

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

const respondWithPdf = () => new Response("%PDF-1.7", { headers: { "Content-Type": "application/pdf" } });
const respondTooLarge = () =>
	new Response("%PDF", { headers: { "Content-Type": "application/pdf", "Content-Length": String(1024) } });

beforeEach(() => {
	fetchMock = vi.fn(async () => respondWithPdf());
	vi.stubGlobal("fetch", fetchMock);
	Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() });
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("Preview labels", () => {
	it("renders Spanish labels on the document, its pages and the page-cap note", async () => {
		const fake = fakePdfjs({ pageCount: 10 });
		renderPreview(<Preview media={privateFile("formulario.pdf")} title="Formulario" maxPages={3} />, {
			loader: async () => fake.pdfjs,
			providerLabels: spanishLabels,
		});

		expect(await screen.findByRole("document", { name: "Formulario, 10 páginas" })).toBeTruthy();
		expect(screen.getByRole("region", { name: "Página 1 de 10" })).toBeTruthy();
		expect(screen.getByText(/Mostrando las primeras 3 de 10 páginas\./)).toBeTruthy();
	});

	it("announces the loading label while the file loads", async () => {
		fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
		renderPreview(<Preview media={privateFile("formulario.pdf")} labels={spanishLabels} />);

		expect((await screen.findByRole("status")).textContent).toBe("Cargando…");
	});

	it("keeps the English default for a label set to undefined", async () => {
		fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
		renderPreview(<Preview media={privateFile("tax-form.pdf")} labels={{ loading: undefined }} />);

		expect((await screen.findByRole("status")).textContent).toBe("Loading…");
	});

	it("titles the default fallback with the error label", async () => {
		fetchMock.mockImplementation(async () => respondTooLarge());
		renderPreview(<Preview media={privateFile("grande.pdf")} maxBytes={10} labels={spanishLabels} />);

		const link = await screen.findByRole("link", { name: "grande.pdf" });
		expect(link.getAttribute("title")).toBe("El archivo es demasiado grande.");
	});

	it("prefers the component's labels over the provider's", async () => {
		const fake = fakePdfjs({ pageCount: 2 });
		renderPreview(<Preview media={privateFile("tax-form.pdf")} labels={{ document: () => "From the prop" }} />, {
			loader: async () => fake.pdfjs,
			providerLabels: spanishLabels,
		});

		expect(await screen.findByRole("document", { name: "From the prop" })).toBeTruthy();
		expect(screen.getByRole("region", { name: "Página 2 de 2" })).toBeTruthy();
	});

	it("labels a thumbnail from its prop, over the provider", async () => {
		const { scrollIntoView } = stubIntersectionObserver();
		const fake = fakePdfjs();
		renderPreview(
			<PdfThumbnail media={privateFile("factura.pdf")} labels={{ thumbnail: (title) => `Vista de ${title}` }} />,
			{
				loader: async () => fake.pdfjs,
				providerLabels: spanishLabels,
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		scrollIntoView();

		expect(await screen.findByRole("img", { name: "Vista de factura.pdf" })).toBeTruthy();
	});
});

describe("<Preview> fallback as a function", () => {
	it("receives the MediaFetchError of a refused fetch", async () => {
		fetchMock.mockImplementation(async () => respondTooLarge());
		const fallback = vi.fn((error: InstanceType<typeof MediaFetchError> | null) => <p>Refused: {error?.code}</p>);
		renderPreview(<Preview media={privateFile("big.pdf")} maxBytes={10} fallback={fallback} />);

		expect(await screen.findByText("Refused: too_large")).toBeTruthy();
		expect(fallback.mock.calls.at(-1)![0]).toBeInstanceOf(MediaFetchError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("receives the HTTP status of an http_error", async () => {
		fetchMock.mockImplementation(async () => new Response("gone", { status: 404 }));
		renderPreview(<Preview media={privateFile("gone.pdf")} fallback={(error) => <p>Status {error?.status}</p>} />);

		expect(await screen.findByText("Status 404")).toBeTruthy();
	});

	it("receives unsupported_type for a type that doesn't preview, without fetching", async () => {
		renderPreview(<Preview media={privateFile("archive.zip")} fallback={(error) => <p>Code: {error?.code}</p>} />);

		expect(await screen.findByText("Code: unsupported_type")).toBeTruthy();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("receives null when pdf.js can't open the file", async () => {
		const fake = fakePdfjs({ failure: new Error("Invalid PDF structure") });
		renderPreview(
			<Preview
				media={privateFile("broken.pdf")}
				fallback={(error) => <p>{error ? error.code : "no fetch error"}</p>}
			/>,
			{ loader: async () => fake.pdfjs },
		);

		expect(await screen.findByText("no fetch error")).toBeTruthy();
	});
});
