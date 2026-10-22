// @vitest-environment jsdom

import type React from "react";
import type { DevulturMedia } from "@devultur/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePdfjs, stubIntersectionObserver } from "./pdf-test-utils";

// The viewer token action is whatever the test sets: it can throw, return nothing, or return a token.
const { tokenAction } = vi.hoisted(() => ({ tokenAction: { current: async (): Promise<unknown> => null } }));
vi.mock("convex/react", () => ({
	useAction: () => () => tokenAction.current(),
	useMutation: () => vi.fn(),
	useQuery: () => undefined,
	useConvex: () => ({}),
}));

const {
	DevulturProvider,
	DownloadLink,
	Image,
	MediaFetchError,
	PdfPreviewProvider,
	PdfThumbnail,
	Preview,
	useDevultur,
} = await import("./react");
const { useMediaObjectUrl } = await import("./media-object-url");

const BASE_URL = "https://media.example";
const api = { issueViewerToken: "issueViewerToken", createUploadUrl: "createUploadUrl", deleteMedia: "deleteMedia" };
const privateFile = (filename: string): DevulturMedia => ({ id: "f1", kind: "file", visibility: "private", filename });

let latest: ReturnType<typeof useDevultur> | null = null;
function Probe() {
	latest = useDevultur();
	return null;
}

function renderWithProvider(element: React.ReactElement) {
	return render(
		<DevulturProvider api={api as never} baseUrl={BASE_URL}>
			<Probe />
			{element}
		</DevulturProvider>,
	);
}

const failingIssuance = () => {
	tokenAction.current = async () => {
		throw new Error("Not signed in");
	};
};
const workingIssuance = () => {
	tokenAction.current = async () => ({ token: "viewer-token", expiresIn: 3600 });
};

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

beforeEach(() => {
	fetchMock = vi.fn(async () => new Response("text body", { headers: { "Content-Type": "text/plain" } }));
	vi.stubGlobal("fetch", fetchMock);
	Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() });
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	latest = null;
});

describe("token status", () => {
	it("goes from loading to ready", async () => {
		let resolveToken: (value: unknown) => void = () => {};
		tokenAction.current = () => new Promise((resolve) => (resolveToken = resolve));
		renderWithProvider(<span />);

		await waitFor(() => expect(latest?.tokenStatus).toBe("loading"));
		await act(async () => resolveToken({ token: "viewer-token", expiresIn: 3600 }));
		expect(latest?.tokenStatus).toBe("ready");
		expect(latest?.tokenError).toBeNull();
	});

	it("is an error when the action throws, and retryToken recovers it", async () => {
		failingIssuance();
		renderWithProvider(<span />);

		await waitFor(() => expect(latest?.tokenStatus).toBe("error"));
		expect(latest?.tokenError?.message).toBe("Not signed in");
		expect(latest?.token).toBeNull();

		workingIssuance();
		await act(async () => {
			await expect(latest!.retryToken()).resolves.toBe("viewer-token");
		});
		expect(latest?.tokenStatus).toBe("ready");
		expect(latest?.tokenError).toBeNull();
	});

	it("is an error when the action returns no token", async () => {
		tokenAction.current = async () => null;
		renderWithProvider(<span />);

		await waitFor(() => expect(latest?.tokenStatus).toBe("error"));
		expect(latest?.tokenError?.message).toMatch(/returned no token/);
	});

	it("doesn't retry a failed issuance on its own", async () => {
		const calls = vi.fn(async () => {
			throw new Error("down");
		});
		tokenAction.current = calls;
		renderWithProvider(<span />);

		await waitFor(() => expect(latest?.tokenStatus).toBe("error"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(calls).toHaveBeenCalledTimes(1);
	});
});

describe("previews when the token can't be issued", () => {
	it("<Preview> renders its fallback with token_unavailable, then the file after a retry", async () => {
		failingIssuance();
		const fallback = vi.fn((error: InstanceType<typeof MediaFetchError> | null) => (
			<span>Unavailable: {error?.code}</span>
		));
		renderWithProvider(<Preview media={privateFile("notes.txt")} fallback={fallback} />);

		expect(await screen.findByText("Unavailable: token_unavailable")).toBeTruthy();
		expect(fetchMock).not.toHaveBeenCalled();

		workingIssuance();
		await act(async () => {
			await latest!.retryToken();
		});
		expect(await screen.findByText("text body")).toBeTruthy();
	});

	it("useMediaObjectUrl fails with token_unavailable without fetching", async () => {
		failingIssuance();
		let result: ReturnType<typeof useMediaObjectUrl> | null = null;
		function ObjectUrlProbe() {
			result = useMediaObjectUrl(privateFile("scan.png"));
			return null;
		}
		renderWithProvider(<ObjectUrlProbe />);

		await waitFor(() => expect((result?.error as { code?: string } | null)?.code).toBe("token_unavailable"));
		expect(result!.isLoading).toBe(false);
		expect((result!.error as Error).cause).toBeInstanceOf(Error);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("<Image> shows its fallback and reports token_unavailable", async () => {
		failingIssuance();
		const onLoadError = vi.fn();
		renderWithProvider(
			<Image
				media={{ ...privateFile("face.png"), kind: "image" }}
				alt="Face"
				fallback={<span>No image</span>}
				onLoadError={onLoadError}
			/>,
		);

		await waitFor(() => expect(onLoadError).toHaveBeenCalled());
		expect(onLoadError.mock.calls[0]![0]).toMatchObject({ code: "token_unavailable" });
		expect(screen.getByText("No image")).toBeTruthy();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("<PdfThumbnail> renders its fallback", async () => {
		failingIssuance();
		const { scrollIntoView } = stubIntersectionObserver();
		const fake = fakePdfjs();
		render(
			<DevulturProvider api={api as never} baseUrl={BASE_URL}>
				<Probe />
				<PdfPreviewProvider pdfjs={async () => fake.pdfjs}>
					<PdfThumbnail media={privateFile("invoice.pdf")} fallback={<span>PDF icon</span>} />
				</PdfPreviewProvider>
			</DevulturProvider>,
		);
		await waitFor(() => expect(latest?.tokenStatus).toBe("error"));
		scrollIntoView();

		expect(await screen.findByText("PDF icon")).toBeTruthy();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("<DownloadLink> reports token_unavailable on click without fetching", async () => {
		failingIssuance();
		const onDownloadError = vi.fn();
		renderWithProvider(
			<DownloadLink media={privateFile("report.csv")} onDownloadError={onDownloadError}>
				Download
			</DownloadLink>,
		);
		await waitFor(() => expect(latest?.tokenStatus).toBe("error"));

		fireEvent.click(screen.getByText("Download"));

		await waitFor(() => expect(onDownloadError).toHaveBeenCalled());
		expect(onDownloadError.mock.calls[0]![0]).toMatchObject({ code: "token_unavailable" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
