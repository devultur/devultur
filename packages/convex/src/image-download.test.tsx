// @vitest-environment jsdom

import type React from "react";
import type { DevulturMedia } from "@devultur/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { actions } = vi.hoisted(() => ({ actions: new Map<string, (args: unknown) => Promise<unknown>>() }));
vi.mock("convex/react", () => ({
	useAction: (reference: string) => (args: unknown) => actions.get(reference)?.(args) ?? Promise.resolve(null),
	useMutation: () => vi.fn(),
	useQuery: () => undefined,
	useConvex: () => ({}),
}));

const { DevulturProvider, DownloadLink, Image } = await import("./react");

const BASE_URL = "https://media.example";
const api = { issueViewerToken: "issueViewerToken", createUploadUrl: "createUploadUrl", deleteMedia: "deleteMedia" };
const privateImage: DevulturMedia = { id: "img1", kind: "image", visibility: "private", filename: "id.png" };
const privateFile: DevulturMedia = { id: "doc1", kind: "file", visibility: "private", filename: "id.pdf" };

function renderWithDevultur(element: React.ReactElement) {
	return render(
		<DevulturProvider api={api as never} baseUrl={BASE_URL}>
			{element}
		</DevulturProvider>,
	);
}

const mismatchResponse = () => new Response(JSON.stringify({ code: "session_mismatch" }), { status: 401 });
const sessionHeaderOf = (init?: RequestInit) => new Headers(init?.headers).get("X-Devultur-Session");

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
let issueViewerToken: ReturnType<typeof vi.fn<(args: unknown) => Promise<unknown>>>;

beforeEach(() => {
	fetchMock = vi.fn(async () => new Response("bytes"));
	vi.stubGlobal("fetch", fetchMock);
	Object.assign(URL, { createObjectURL: vi.fn(() => "blob:media"), revokeObjectURL: vi.fn() });
	issueViewerToken = vi
		.fn()
		.mockResolvedValueOnce({ token: "viewer-token", expiresIn: 3600 })
		.mockResolvedValue({ token: "fresh-token", expiresIn: 3600 });
	actions.set("issueViewerToken", issueViewerToken);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	actions.clear();
});

describe("<Image> with private media", () => {
	it("renders the blob fetched with the session header", async () => {
		renderWithDevultur(<Image media={privateImage} alt="ID" />);

		const image = await screen.findByRole("img", { name: "ID" });
		expect(image.getAttribute("src")).toBe("blob:media");
		expect(sessionHeaderOf(fetchMock.mock.calls[0]![1])).toEqual(expect.any(String));
	});

	it("re-issues once on a 401 session_mismatch and renders the retried blob", async () => {
		fetchMock.mockResolvedValueOnce(mismatchResponse());
		renderWithDevultur(<Image media={privateImage} alt="ID" />);

		await screen.findByRole("img", { name: "ID" });
		await waitFor(() => expect(issueViewerToken).toHaveBeenCalledTimes(2));
		expect(fetchMock.mock.calls.some(([url]) => url.includes("token=fresh-token"))).toBe(true);
	});

	it("renders the fallback when the retry is refused too, without a second re-issue", async () => {
		fetchMock.mockImplementation(async () => mismatchResponse());
		renderWithDevultur(<Image media={privateImage} alt="ID" fallback={<p>No image</p>} />);

		await waitFor(() => expect(issueViewerToken).toHaveBeenCalledTimes(2));
		expect(await screen.findByText("No image")).toBeTruthy();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(issueViewerToken).toHaveBeenCalledTimes(2);
	});
});

describe("<DownloadLink> with private media", () => {
	it("downloads the blob fetched with the session header, re-issuing once on a 401 session_mismatch", async () => {
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		renderWithDevultur(<DownloadLink media={privateFile}>Download</DownloadLink>);
		await waitFor(() => expect(issueViewerToken).toHaveBeenCalledOnce());
		fetchMock.mockResolvedValueOnce(mismatchResponse());

		fireEvent.click(screen.getByRole("link", { name: "Download" }));

		await waitFor(() => expect(click).toHaveBeenCalledOnce());
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]![0]).toContain("token=viewer-token");
		expect(fetchMock.mock.calls[1]![0]).toContain("token=fresh-token");
		expect(sessionHeaderOf(fetchMock.mock.calls[1]![1])).toEqual(expect.any(String));
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:media");
		click.mockRestore();
	});
});
