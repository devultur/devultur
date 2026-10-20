// @vitest-environment jsdom

import type React from "react";
import { act, renderHook } from "@testing-library/react";
import { convexToJson, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `useAction(reference)` returns the spy registered for that reference (the api's references are plain strings here).
const { actions } = vi.hoisted(() => ({ actions: new Map<string, (args: unknown) => Promise<unknown>>() }));
vi.mock("convex/react", () => ({
	useAction: (reference: string) => (args: unknown) => {
		const action = actions.get(reference);
		if (!action) throw new Error(`No action ${reference}`);
		return action(args);
	},
	useMutation: () => vi.fn(),
	useQuery: () => undefined,
	useConvex: () => ({}),
}));

const { DevulturProvider, useDevultur } = await import("./react");

const UPLOAD_KEY = "private/file/abc123/doc.pdf";
const UPLOAD_TARGET = {
	url: "https://uploads.example/put",
	key: UPLOAD_KEY,
	id: "abc123",
	kind: "file",
	visibility: "private",
};

/** An XHR whose PUT reports half the body, then all of it, then succeeds. */
class FakeXhr extends EventTarget {
	static sent: Array<{ method: string; url: string; body: unknown }> = [];
	readonly upload = new EventTarget();
	status = 0;
	responseText = "";
	private method = "";
	private url = "";

	open(method: string, url: string) {
		this.method = method;
		this.url = url;
	}

	setRequestHeader() {}

	abort() {}

	send(body: Blob) {
		FakeXhr.sent.push({ method: this.method, url: this.url, body });
		const progress = (loaded: number) =>
			new ProgressEvent("progress", { lengthComputable: true, loaded, total: body.size });
		queueMicrotask(() => {
			this.upload.dispatchEvent(progress(body.size / 2));
			this.upload.dispatchEvent(progress(body.size));
			this.status = 200;
			this.responseText = "{}";
			this.dispatchEvent(new Event("load"));
		});
	}
}

const api = {
	issueViewerToken: "issueViewerToken",
	createUploadUrl: "createUploadUrl",
	confirmUpload: "confirmUpload",
	deleteMedia: "deleteMedia",
} as never;

function renderDevultur(providerApi = api) {
	const wrapper = ({ children }: { children: React.ReactNode }) => (
		<DevulturProvider api={providerApi}>{children}</DevulturProvider>
	);
	return renderHook(() => useDevultur(), { wrapper });
}

const pdf = () => new File(["0123456789ab"], "doc.pdf", { type: "application/pdf" });

let confirmUpload: ReturnType<typeof vi.fn<(args: unknown) => Promise<unknown>>>;

beforeEach(() => {
	FakeXhr.sent = [];
	vi.stubGlobal("XMLHttpRequest", FakeXhr);
	confirmUpload = vi.fn(async (_args: unknown) => null as unknown);
	actions.set("issueViewerToken", async () => ({ token: "viewer-token", expiresIn: 3600 }));
	actions.set("createUploadUrl", async () => UPLOAD_TARGET);
	actions.set("confirmUpload", confirmUpload);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	actions.clear();
});

describe("useDevultur().upload()", () => {
	it("reports the PUT's progress in bytes and as a fraction", async () => {
		const { result } = renderDevultur();
		const onProgress = vi.fn();

		await act(() => result.current.upload(pdf(), { onProgress }));

		expect(FakeXhr.sent).toEqual([{ method: "PUT", url: UPLOAD_TARGET.url, body: expect.any(File) }]);
		expect(onProgress).toHaveBeenNthCalledWith(1, { loadedBytes: 6, totalBytes: 12, fraction: 0.5 });
		expect(onProgress).toHaveBeenLastCalledWith({ loadedBytes: 12, totalBytes: 12, fraction: 1 });
	});

	it("returns the reference with the uploaded key, which survives a spread and a Convex call", async () => {
		const { result } = renderDevultur();

		const media = await act(() => result.current.upload(pdf()));

		const reference = { id: "abc123", kind: "file", visibility: "private", filename: "doc.pdf", key: UPLOAD_KEY };
		expect(media).toEqual(reference);
		expect({ ...media }).toEqual(reference);
		expect(convexToJson(media as unknown as Value)).toEqual(reference);
	});

	it("confirms the upload after the PUT, so it shows in listMedia", async () => {
		const { result } = renderDevultur();

		await act(() => result.current.upload(pdf()));

		expect(confirmUpload).toHaveBeenCalledWith({ key: UPLOAD_KEY, filename: "doc.pdf" });
	});

	it("still uploads when the confirm fails, or the api has no confirmUpload", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		confirmUpload.mockRejectedValueOnce(new Error("offline"));
		const withConfirm = renderDevultur();
		await expect(act(() => withConfirm.result.current.upload(pdf()))).resolves.toMatchObject({ id: "abc123" });

		const { confirmUpload: _confirm, ...apiWithoutConfirm } = api as Record<string, string>;
		const withoutConfirm = renderDevultur(apiWithoutConfirm as never);
		await expect(act(() => withoutConfirm.result.current.upload(pdf()))).resolves.toMatchObject({ id: "abc123" });
		expect(confirmUpload).toHaveBeenCalledOnce();
	});

	it("rejects with an AbortError when its signal is already aborted", async () => {
		const { result } = renderDevultur();
		const controller = new AbortController();
		controller.abort();

		await expect(act(() => result.current.upload(pdf(), { signal: controller.signal }))).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(confirmUpload).not.toHaveBeenCalled();
	});
});
