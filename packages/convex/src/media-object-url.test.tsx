// @vitest-environment jsdom

import type React from "react";
import type { DevulturMedia } from "@devultur/core";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { actions } = vi.hoisted(() => ({ actions: new Map<string, (args: unknown) => Promise<unknown>>() }));
vi.mock("convex/react", () => ({
	useAction: (reference: string) => (args: unknown) => actions.get(reference)?.(args) ?? Promise.resolve(null),
	useMutation: () => vi.fn(),
	useQuery: () => undefined,
	useConvex: () => ({}),
}));

const { DevulturProvider, MediaFetchError, useMediaObjectUrl } = await import("./react");

const BASE_URL = "https://media.example";
const api = { issueViewerToken: "issueViewerToken", createUploadUrl: "createUploadUrl", deleteMedia: "deleteMedia" };
const privatePdf: DevulturMedia = { id: "doc1", kind: "file", visibility: "private", filename: "id.pdf" };
const otherPdf: DevulturMedia = { id: "doc2", kind: "file", visibility: "private", filename: "tax.pdf" };

const wrapper = ({ children }: { children: React.ReactNode }) => (
	<DevulturProvider api={api as never} baseUrl={BASE_URL}>
		{children}
	</DevulturProvider>
);

const pdfResponse = (headers: Record<string, string> = {}) =>
	new Response("%PDF-1.7", { headers: { "Content-Type": "application/pdf", ...headers } });
const mismatchResponse = () => new Response(JSON.stringify({ code: "session_mismatch" }), { status: 401 });

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
let objectUrlCount = 0;

beforeEach(() => {
	objectUrlCount = 0;
	fetchMock = vi.fn(async () => pdfResponse());
	vi.stubGlobal("fetch", fetchMock);
	Object.assign(URL, {
		createObjectURL: vi.fn(() => `blob:${BASE_URL}/${++objectUrlCount}`),
		revokeObjectURL: vi.fn(),
	});
	actions.set("issueViewerToken", async () => ({ token: "viewer-token", expiresIn: 3600 }));
});

afterEach(() => {
	vi.unstubAllGlobals();
	actions.clear();
});

describe("useMediaObjectUrl", () => {
	it("fetches private media with the session header and returns an object URL", async () => {
		const { result } = renderHook(() => useMediaObjectUrl(privatePdf), { wrapper });

		await waitFor(() => expect(result.current.objectUrl).toBe(`blob:${BASE_URL}/1`));
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe(`${BASE_URL}/v1/media/private/file/doc1/id.pdf?token=viewer-token`);
		expect(new Headers(init?.headers).get("X-Devultur-Session")).toEqual(expect.any(String));
		expect(result.current).toMatchObject({ contentType: "application/pdf", isLoading: false, error: null });
	});

	it("re-issues the token once and retries on a 401 session_mismatch", async () => {
		const issueViewerToken = vi
			.fn()
			.mockResolvedValueOnce({ token: "viewer-token", expiresIn: 3600 })
			.mockResolvedValueOnce({ token: "fresh-token", expiresIn: 3600 });
		actions.set("issueViewerToken", issueViewerToken);
		fetchMock.mockResolvedValueOnce(mismatchResponse());

		const { result } = renderHook(() => useMediaObjectUrl(privatePdf), { wrapper });

		await waitFor(() => expect(result.current.objectUrl).not.toBeNull());
		expect(issueViewerToken).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1]![0]).toContain("token=fresh-token");
	});

	it("fails with http_error when the retry is refused too, without a second re-issue", async () => {
		fetchMock.mockImplementation(async () => mismatchResponse());

		const { result } = renderHook(() => useMediaObjectUrl(privatePdf), { wrapper });

		await waitFor(() => expect(result.current.error).toBeInstanceOf(MediaFetchError));
		expect(result.current.error).toMatchObject({ code: "http_error", status: 401 });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("revokes the object URL when the media changes and on unmount", async () => {
		const { result, rerender, unmount } = renderHook(({ media }) => useMediaObjectUrl(media), {
			wrapper,
			initialProps: { media: privatePdf },
		});
		await waitFor(() => expect(result.current.objectUrl).toBe(`blob:${BASE_URL}/1`));

		rerender({ media: otherPdf });
		expect(URL.revokeObjectURL).toHaveBeenCalledWith(`blob:${BASE_URL}/1`);
		await waitFor(() => expect(result.current.objectUrl).toBe(`blob:${BASE_URL}/2`));

		unmount();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith(`blob:${BASE_URL}/2`);
	});

	it("doesn't fetch while disabled or without media", async () => {
		const disabled = renderHook(() => useMediaObjectUrl(privatePdf, { enabled: false }), { wrapper });
		const empty = renderHook(() => useMediaObjectUrl(null), { wrapper });

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fetchMock).not.toHaveBeenCalled();
		expect(disabled.result.current).toEqual({ objectUrl: null, contentType: null, isLoading: false, error: null });
		expect(empty.result.current.objectUrl).toBeNull();
	});

	it("aborts the in-flight fetch on unmount and never creates a stale object URL", async () => {
		let resolveFetch: (response: Response) => void = () => {};
		fetchMock.mockImplementation(() => new Promise((resolve) => (resolveFetch = resolve)));
		const { unmount } = renderHook(() => useMediaObjectUrl(privatePdf), { wrapper });
		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		const signal = fetchMock.mock.calls[0]![1]?.signal;

		unmount();
		resolveFetch(pdfResponse());
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(signal?.aborted).toBe(true);
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it("refuses a body whose Content-Length exceeds maxBytes", async () => {
		fetchMock.mockResolvedValue(pdfResponse({ "Content-Length": "5000" }));

		const { result } = renderHook(() => useMediaObjectUrl(privatePdf, { maxBytes: 1000 }), { wrapper });

		await waitFor(() => expect(result.current.error).toMatchObject({ code: "too_large" }));
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it("stops reading when the streamed body exceeds maxBytes", async () => {
		const chunk = new Uint8Array(600);
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(chunk);
			},
		});
		fetchMock.mockResolvedValue(new Response(body, { headers: { "Content-Type": "application/pdf" } }));

		const { result } = renderHook(() => useMediaObjectUrl(privatePdf, { maxBytes: 1000 }), { wrapper });

		await waitFor(() => expect(result.current.error).toMatchObject({ code: "too_large" }));
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it("creates the blob with the expected type, and refuses a response that disagrees", async () => {
		fetchMock.mockResolvedValueOnce(pdfResponse({ "Content-Type": "application/pdf; charset=binary" }));
		const agreed = renderHook(() => useMediaObjectUrl(privatePdf, { contentType: "application/pdf" }), { wrapper });
		await waitFor(() => expect(agreed.result.current.objectUrl).not.toBeNull());
		const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
		expect(blob.type).toBe("application/pdf");

		fetchMock.mockResolvedValueOnce(new Response("<script>", { headers: { "Content-Type": "text/html" } }));
		const mismatched = renderHook(() => useMediaObjectUrl(otherPdf, { contentType: "application/pdf" }), { wrapper });
		await waitFor(() => expect(mismatched.result.current.error).toMatchObject({ code: "type_mismatch" }));
		expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
	});

	it("labels a non-previewable response application/octet-stream", async () => {
		fetchMock.mockResolvedValue(
			new Response("<svg onload=alert(1)>", { headers: { "Content-Type": "image/svg+xml" } }),
		);

		const { result } = renderHook(() => useMediaObjectUrl(privatePdf), { wrapper });

		await waitFor(() => expect(result.current.contentType).toBe("application/octet-stream"));
		expect((vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob).type).toBe("application/octet-stream");
	});

	it("returns the delivery URL for public media without fetching", () => {
		const publicPdf: DevulturMedia = { ...privatePdf, visibility: "public" };

		const { result } = renderHook(() => useMediaObjectUrl(publicPdf), { wrapper });

		expect(result.current.objectUrl).toBe(`${BASE_URL}/v1/media/public/file/doc1/id.pdf`);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
