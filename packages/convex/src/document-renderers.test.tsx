// @vitest-environment jsdom

import type React from "react";
import type { DevulturMedia } from "@devultur/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { actions } = vi.hoisted(() => ({ actions: new Map<string, (args: unknown) => Promise<unknown>>() }));
vi.mock("convex/react", () => ({
	useAction: (reference: string) => (args: unknown) => actions.get(reference)?.(args) ?? Promise.resolve(null),
	useMutation: () => vi.fn(),
	useQuery: () => undefined,
	useConvex: () => ({}),
}));

const { AttachmentCard, DevulturProvider, DocumentLink } = await import("./react");
const { attachmentLabels: spanishLabels } = await import("./locales/es");

const BASE_URL = "https://media.example";
const api = { issueViewerToken: "issueViewerToken", createUploadUrl: "createUploadUrl", deleteMedia: "deleteMedia" };
const publicPdf: DevulturMedia = {
	id: "doc1",
	kind: "file",
	visibility: "public",
	filename: "report.pdf",
	title: "Annual report",
	sizeBytes: 2_400_000,
	pageCount: 12,
};
const privatePdf: DevulturMedia = { ...publicPdf, visibility: "private", title: undefined };

function renderWithDevultur(element: React.ReactElement) {
	return render(
		<DevulturProvider api={api as never} baseUrl={BASE_URL}>
			{element}
		</DevulturProvider>,
	);
}

const sessionHeaderOf = (init?: RequestInit) => new Headers(init?.headers).get("X-Devultur-Session");

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
let issueViewerToken: ReturnType<typeof vi.fn<(args: unknown) => Promise<unknown>>>;

beforeEach(() => {
	fetchMock = vi.fn(async () => new Response("bytes"));
	vi.stubGlobal("fetch", fetchMock);
	Object.assign(URL, { createObjectURL: vi.fn(() => "blob:media"), revokeObjectURL: vi.fn() });
	issueViewerToken = vi.fn().mockResolvedValue({ token: "viewer-token", expiresIn: 3600 });
	actions.set("issueViewerToken", issueViewerToken);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	actions.clear();
});

describe("<DocumentLink>", () => {
	it("links a public file to its delivery URL, named by its title", () => {
		renderWithDevultur(<DocumentLink media={publicPdf} target="_blank" />);

		const link = screen.getByRole("link", { name: "Annual report" });
		expect(link.getAttribute("href")).toBe(`${BASE_URL}/v1/media/public/file/doc1/report.pdf`);
		expect(link.hasAttribute("download")).toBe(false);
		expect(link.getAttribute("target")).toBe("_blank");
	});

	it("downloads a public file with `download`", () => {
		renderWithDevultur(<DocumentLink media={publicPdf} download />);

		const link = screen.getByRole("link", { name: "Annual report" });
		expect(link.hasAttribute("download")).toBe(true);
		expect(link.getAttribute("href")).toContain("download");
	});

	it("falls back to the filename, then to the untitled label", () => {
		renderWithDevultur(
			<>
				<DocumentLink media={{ ...publicPdf, title: undefined }} />
				<DocumentLink media={{ id: "doc2", kind: "file", visibility: "public" }} labels={spanishLabels} />
			</>,
		);

		expect(screen.getByRole("link", { name: "report.pdf" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "Archivo sin título" })).toBeTruthy();
	});

	it("fetches a private file with the session header and downloads the blob", async () => {
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		renderWithDevultur(<DocumentLink media={privatePdf} />);
		await waitFor(() => expect(issueViewerToken).toHaveBeenCalledOnce());

		fireEvent.click(screen.getByRole("link", { name: "report.pdf" }));

		await waitFor(() => expect(click).toHaveBeenCalledOnce());
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0]![0]).toContain("token=viewer-token");
		expect(sessionHeaderOf(fetchMock.mock.calls[0]![1])).toEqual(expect.any(String));
		click.mockRestore();
	});
});

describe("<AttachmentCard>", () => {
	it("renders an article named by its heading, with type, size and page count", () => {
		renderWithDevultur(<AttachmentCard media={publicPdf} />);

		const card = screen.getByRole("article", { name: "Annual report" });
		expect(within(card).getByRole("heading", { level: 3, name: "Annual report" })).toBeTruthy();
		expect(within(card).getByText("PDF · 2.4 MB · 12 pages")).toBeTruthy();
		expect(card.getAttribute("data-kind")).toBe("pdf");
		expect(within(card).getByRole("link", { name: "Download" }).getAttribute("aria-describedby")).toBeTruthy();
		expect(within(card).queryByRole("button")).toBeNull();
	});

	it.each([
		[{ id: "a1", kind: "file", visibility: "public", filename: "song.mp3", duration: 65 }, "audio", "Audio · 1:05"],
		[
			{ id: "v1", kind: "video", visibility: "public", filename: "clip.mp4", duration: 3723 },
			"video",
			"Video · 1:02:03",
		],
		[
			{ id: "i1", kind: "image", visibility: "public", filename: "cover.png", sizeBytes: 900 },
			"image",
			"Image · 900 bytes",
		],
		[{ id: "z1", kind: "file", visibility: "public", filename: "data.zip" }, "file", "File"],
	] as const)("renders %o as a %s card", (media, kind, details) => {
		renderWithDevultur(<AttachmentCard media={media} />);

		const card = screen.getByRole("article");
		expect(card.getAttribute("data-kind")).toBe(kind);
		expect(card.querySelector(`svg[data-kind="${kind}"]`)).toBeTruthy();
		expect(within(card).getByText(details)).toBeTruthy();
	});

	it("formats in Spanish with the Spanish labels", () => {
		renderWithDevultur(<AttachmentCard media={publicPdf} labels={spanishLabels} headingLevel={2} onOpen={() => {}} />);

		const card = screen.getByRole("article", { name: "Annual report" });
		expect(within(card).getByRole("heading", { level: 2 })).toBeTruthy();
		expect(within(card).getByText("PDF · 2,4 MB · 12 páginas")).toBeTruthy();
		expect(within(card).getByRole("link", { name: "Descargar" })).toBeTruthy();
		expect(within(card).getByRole("button", { name: "Abrir vista previa" })).toBeTruthy();
	});

	it("lets the `locale` prop pick the size format", () => {
		renderWithDevultur(<AttachmentCard media={publicPdf} locale="es" />);

		expect(screen.getByText("PDF · 2,4 MB · 12 pages")).toBeTruthy();
	});

	it("calls onOpen with the media and renders a custom preview instead of the icon", () => {
		const handleOpen = vi.fn();
		renderWithDevultur(<AttachmentCard media={publicPdf} onOpen={handleOpen} preview={<span>thumb</span>} />);

		fireEvent.click(screen.getByRole("button", { name: "Open preview" }));

		expect(handleOpen).toHaveBeenCalledWith(publicPdf);
		expect(screen.getByText("thumb")).toBeTruthy();
		expect(screen.getByRole("article").querySelector("svg")).toBeNull();
	});

	it("renders nothing without media", () => {
		const { container } = renderWithDevultur(<AttachmentCard media={null} />);
		expect(container.innerHTML).toBe("");
	});
});
