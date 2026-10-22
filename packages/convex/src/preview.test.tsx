// @vitest-environment jsdom

import type React from "react";
import type { DevulturMedia } from "@devultur/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { actions } = vi.hoisted(() => ({ actions: new Map<string, (args: unknown) => Promise<unknown>>() }));
vi.mock("convex/react", () => ({
	useAction: (reference: string) => (args: unknown) => actions.get(reference)?.(args) ?? Promise.resolve(null),
	useMutation: () => vi.fn(),
	useQuery: () => undefined,
	useConvex: () => ({}),
}));

const { DevulturProvider, Preview } = await import("./react");

const BASE_URL = "https://media.example";
const api = { issueViewerToken: "issueViewerToken", createUploadUrl: "createUploadUrl", deleteMedia: "deleteMedia" };

const privateFile = (filename: string): DevulturMedia => ({ id: "f1", kind: "file", visibility: "private", filename });

function renderPreview(element: React.ReactElement) {
	return render(
		<DevulturProvider api={api as never} baseUrl={BASE_URL}>
			{element}
		</DevulturProvider>,
	);
}

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

function respondWith(body: string, contentType: string) {
	fetchMock.mockImplementation(async () => new Response(body, { headers: { "Content-Type": contentType } }));
}

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() });
	actions.set("issueViewerToken", async () => ({ token: "viewer-token", expiresIn: 3600 }));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	actions.clear();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("<Preview>", () => {
	it("renders a PNG in an <img> with the forced type", async () => {
		respondWith("png-bytes", "image/png");
		renderPreview(<Preview media={privateFile("passport.png")} />);

		const image = await screen.findByRole("img", { name: "passport.png" });
		expect(image.getAttribute("src")).toBe("blob:preview");
		expect((vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob).type).toBe("image/png");
	});

	it("renders a PDF in a titled <iframe> backed by an application/pdf blob", async () => {
		respondWith("%PDF-1.7", "application/pdf");
		const { container } = renderPreview(<Preview media={privateFile("tax-form.pdf")} title="Tax form" />);

		await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
		const frame = container.querySelector("iframe")!;
		expect(frame.getAttribute("src")).toBe("blob:preview");
		expect(frame.getAttribute("title")).toBe("Tax form");
		expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect((vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob).type).toBe("application/pdf");
	});

	it("verifies a public PDF into a forced-type blob instead of framing its delivery URL", async () => {
		respondWith("%PDF-1.7", "application/pdf");
		const publicPdf: DevulturMedia = { ...privateFile("brochure.pdf"), visibility: "public" };
		const { container } = renderPreview(<Preview media={publicPdf} />);

		await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
		expect(container.querySelector("iframe")!.getAttribute("src")).toBe("blob:preview");
		expect((vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob).type).toBe("application/pdf");
	});

	it("never frames a public PDF served as text/html", async () => {
		respondWith("<script>alert(1)</script>", "text/html");
		const publicPdf: DevulturMedia = { ...privateFile("brochure.pdf"), visibility: "public" };
		const { container } = renderPreview(<Preview media={publicPdf} fallback={<p>Download</p>} />);

		expect(await screen.findByText("Download")).toBeTruthy();
		expect(container.querySelector("iframe")).toBeNull();
	});

	it("keeps a public image on its delivery URL, unfetched", async () => {
		const publicImage: DevulturMedia = { ...privateFile("cover.webp"), visibility: "public" };
		renderPreview(<Preview media={publicImage} />);

		const image = await screen.findByRole("img", { name: "cover.webp" });
		expect(image.getAttribute("src")).toBe(`${BASE_URL}/v1/media/public/file/f1/cover.webp`);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("caps binary previews at 50 MiB by default", async () => {
		fetchMock.mockResolvedValue(
			new Response("%PDF", {
				headers: { "Content-Type": "application/pdf", "Content-Length": String(51 * 1024 * 1024) },
			}),
		);
		renderPreview(<Preview media={privateFile("huge.pdf")} fallback={<p>Too big</p>} />);

		expect(await screen.findByText("Too big")).toBeTruthy();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it("renders audio in <audio controls>", async () => {
		respondWith("id3", "audio/mpeg");
		const { container } = renderPreview(<Preview media={privateFile("note.mp3")} />);

		await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
		expect(container.querySelector("audio")!.hasAttribute("controls")).toBe(true);
	});

	it("renders text, CSV and JSON as escaped text in a <pre>, without an object URL", async () => {
		respondWith('{"name":"<b>Ana</b>"}', "application/json; charset=utf-8");
		const { container } = renderPreview(<Preview media={privateFile("data.json")} />);

		await waitFor(() => expect(container.querySelector("pre")).not.toBeNull());
		expect(container.querySelector("pre")!.textContent).toBe('{"name":"<b>Ana</b>"}');
		expect(container.querySelector("b")).toBeNull();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it("renders the fallback when the text body exceeds maxTextBytes", async () => {
		respondWith("x".repeat(100), "text/plain");
		renderPreview(<Preview media={privateFile("log.txt")} maxTextBytes={10} fallback={<p>Too big</p>} />);

		expect(await screen.findByText("Too big")).toBeTruthy();
	});

	it.each([
		"page.html",
		"logo.svg",
		"feed.xml",
		"page.xhtml",
		"archive.zip",
		"README",
	])("renders the download fallback for %s without fetching", async (filename) => {
		renderPreview(<Preview media={privateFile(filename)} />);
		await settle();

		expect(screen.getByRole("link").getAttribute("download")).not.toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it("never renders a declared-PDF response that says text/html", async () => {
		respondWith("<script>alert(document.cookie)</script>", "text/html");
		const { container } = renderPreview(<Preview media={privateFile("contract.pdf")} fallback={<p>Download</p>} />);

		expect(await screen.findByText("Download")).toBeTruthy();
		expect(container.querySelector("iframe")).toBeNull();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it("never renders an image response that says image/svg+xml", async () => {
		respondWith("<svg onload=alert(1)>", "image/svg+xml");
		const { container } = renderPreview(<Preview media={privateFile("photo.png")} fallback={<p>Download</p>} />);

		expect(await screen.findByText("Download")).toBeTruthy();
		expect(container.querySelector("img")).toBeNull();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it("plays video through the streaming player, never a blob", async () => {
		const video: DevulturMedia = { id: "v1", kind: "video", visibility: "private", filename: "clip.mp4" };
		const { container } = renderPreview(<Preview media={video} />);
		await settle();

		expect(container.querySelector("video")).not.toBeNull();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it("uses the declared contentType over the filename", async () => {
		respondWith("%PDF-1.7", "application/pdf");
		const { container } = renderPreview(<Preview media={privateFile("upload")} contentType="application/pdf" />);

		await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
	});
});
