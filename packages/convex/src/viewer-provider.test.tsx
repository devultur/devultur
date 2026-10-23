// @vitest-environment jsdom

import type { DevulturMedia } from "@devultur/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devulturErrorLabels as spanishErrorLabels } from "./locales/es";

const { calls, convexClient } = vi.hoisted(() => ({
	calls: [] as Array<{ reference: string; args: unknown }>,
	// Off → `useAction` throws like it does with no `<ConvexProvider>` above it.
	convexClient: { isMounted: true },
}));
vi.mock("convex/react", () => ({
	useAction: (reference: string) => {
		if (!convexClient.isMounted) throw new Error("Could not find Convex client!");
		return async (args: unknown) => {
			calls.push({ reference, args });
			return { token: "viewer-token", expiresIn: 3600 };
		};
	},
	useMutation: () => vi.fn(),
	useQuery: () => undefined,
	useConvex: () => ({}),
	usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
}));

const {
	DevulturCapabilityError,
	DevulturProvider,
	DevulturViewerProvider,
	Image,
	Preview,
	useDevultur,
	useDevulturApi,
	useDevulturOptional,
	useMediaUpload,
	useMediaUrl,
} = await import("./react");
const { describeDevulturError } = await import("./error-labels");

const BASE_URL = "https://media.example";
const privateFile: DevulturMedia = { id: "f1", kind: "file", visibility: "private", filename: "notes.txt" };
const publicFile: DevulturMedia = { id: "f2", kind: "file", visibility: "public", filename: "readme.txt" };
const publicImage: DevulturMedia = { id: "i1", kind: "image", visibility: "public", filename: "cover.png" };
const unavailable = (error: { code: string }) => <span>Unavailable: {error.code}</span>;

let latest: ReturnType<typeof useDevultur> | null = null;
function Probe() {
	latest = useDevultur();
	return null;
}

function ViewerHarness({ lazyToken, children }: { lazyToken?: boolean; children: React.ReactNode }) {
	return (
		<DevulturViewerProvider
			baseUrl={BASE_URL}
			issueViewerToken={"admin.issueViewerToken" as never}
			tokenArgs={{ workspaceId: "w1" }}
			lazyToken={lazyToken}
		>
			<Probe />
			{children}
		</DevulturViewerProvider>
	);
}

function renderViewer(children: React.ReactNode, options?: { lazyToken?: boolean }) {
	return render(<ViewerHarness lazyToken={options?.lazyToken}>{children}</ViewerHarness>);
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("hello", { headers: { "Content-Type": "text/plain" } })),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	calls.length = 0;
	convexClient.isMounted = true;
	latest = null;
});

describe("<DevulturViewerProvider>", () => {
	it("issues the token with its own action and args, and previews private media", async () => {
		renderViewer(<Preview media={privateFile} />);

		expect(await screen.findByText("hello")).toBeTruthy();
		expect(calls).toEqual([
			{ reference: "admin.issueViewerToken", args: { workspaceId: "w1", sessionSecret: expect.any(String) } },
		]);
		expect(latest?.tokenStatus).toBe("ready");
	});

	it("issues the token as soon as it mounts by default, with only public media", async () => {
		renderViewer(<Preview media={publicFile} />);

		await waitFor(() => expect(latest?.tokenStatus).toBe("ready"));
		expect(latest?.token).toBe("viewer-token");
		expect(calls).toHaveLength(1);
	});

	it("with lazyToken, issues no token while every media shown is public", async () => {
		renderViewer(<Preview media={publicFile} />, { lazyToken: true });

		expect(await screen.findByText("hello")).toBeTruthy();
		expect(calls).toEqual([]);
		expect(latest?.tokenStatus).toBe("idle");
		expect(latest?.token).toBeNull();
	});

	it("with lazyToken, issues the token once the first private media is shown", async () => {
		const view = renderViewer(<Preview media={publicFile} />, { lazyToken: true });
		await screen.findByText("hello");
		expect(calls).toHaveLength(0);

		view.rerender(
			<ViewerHarness lazyToken>
				<Preview media={publicFile} />
				<Preview media={privateFile} />
			</ViewerHarness>,
		);

		await waitFor(() => expect(latest?.tokenStatus).toBe("ready"));
		expect(calls).toHaveLength(1);
	});

	it("with lazyToken, issues the token when url() builds a private URL during a render", async () => {
		function PrivateLink() {
			const { url } = useDevultur();
			return <a href={url(privateFile)}>Download notes</a>;
		}
		renderViewer(<PrivateLink />, { lazyToken: true });

		await waitFor(() => expect(latest?.tokenStatus).toBe("ready"));
		expect(calls).toHaveLength(1);
		expect(screen.getByText("Download notes").getAttribute("href")).toContain("viewer-token");
	});

	it("with lazyToken, useMediaUrl asks for a token for any key that isn't public", async () => {
		function KeyUrl({ mediaKey }: { mediaKey: string }) {
			return <span>{useMediaUrl(mediaKey)}</span>;
		}
		const view = renderViewer(<KeyUrl mediaKey="public/image/i1/cover.png" />, { lazyToken: true });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(calls).toHaveLength(0);

		view.rerender(
			<ViewerHarness lazyToken>
				<KeyUrl mediaKey="legacy/cover.png" />
			</ViewerHarness>,
		);
		await waitFor(() => expect(latest?.tokenStatus).toBe("ready"));
		expect(calls).toHaveLength(1);
	});

	it("shows public media with no token action and no Convex client", async () => {
		convexClient.isMounted = false;
		render(
			<DevulturViewerProvider baseUrl={BASE_URL}>
				<Probe />
				<Preview media={publicFile} />
				<Image media={publicImage} alt="cover" />
			</DevulturViewerProvider>,
		);

		expect(await screen.findByText("hello")).toBeTruthy();
		expect(screen.getByAltText("cover").getAttribute("src")).toBe(`${BASE_URL}/v1/media/public/image/i1/cover.png`);
		expect(latest?.tokenStatus).toBe("idle");
	});

	it("fails private media with token_unavailable when there is no token action", async () => {
		convexClient.isMounted = false;
		render(
			<DevulturViewerProvider baseUrl={BASE_URL}>
				<Probe />
				<Preview media={privateFile} fallback={unavailable} />
			</DevulturViewerProvider>,
		);

		expect(await screen.findByText("Unavailable: token_unavailable")).toBeTruthy();
		expect(latest?.tokenStatus).toBe("error");
		expect(latest?.tokenError?.message).toMatch(/no `issueViewerToken`/);
		await expect(latest!.retryToken()).resolves.toBeNull();
	});

	it("rejects upload and uploadUrl, and throws on deleteMedia, with capability_unavailable", async () => {
		renderViewer(null);
		await waitFor(() => expect(latest).not.toBeNull());
		const file = new File(["x"], "a.png", { type: "image/png" });

		await expect(latest!.upload(file)).rejects.toMatchObject({ code: "capability_unavailable", capability: "upload" });
		await expect(latest!.uploadUrl(file)).rejects.toBeInstanceOf(DevulturCapabilityError);
		expect(() => latest!.deleteMedia(privateFile)).toThrow(DevulturCapabilityError);
	});

	it("throws capability_unavailable from hooks that need the api", () => {
		const errors: unknown[] = [];
		function ApiProbe({ hook }: { hook: () => unknown }) {
			try {
				hook();
			} catch (error) {
				errors.push(error);
			}
			return null;
		}
		renderViewer(
			<>
				<ApiProbe hook={useDevulturApi} />
				<ApiProbe hook={() => useMediaUpload()} />
			</>,
		);

		expect(errors.length).toBeGreaterThanOrEqual(2);
		for (const error of errors) expect(error).toMatchObject({ code: "capability_unavailable", capability: "api" });
	});

	it("keeps issuing the token right away under <DevulturProvider>", async () => {
		const api = {
			issueViewerToken: "issueViewerToken",
			createUploadUrl: "createUploadUrl",
			deleteMedia: "deleteMedia",
		};
		render(
			<DevulturProvider api={api as never} baseUrl={BASE_URL}>
				<Probe />
			</DevulturProvider>,
		);

		await waitFor(() => expect(latest?.tokenStatus).toBe("ready"));
		expect(calls).toEqual([{ reference: "issueViewerToken", args: { sessionSecret: expect.any(String) } }]);
	});

	it("describes the capability error in English and Spanish", () => {
		const error = new DevulturCapabilityError("upload");
		expect(describeDevulturError(error)).toBe("This app can't do that here.");
		expect(describeDevulturError(error, spanishErrorLabels)).toBe("Esta aplicación no puede hacer eso aquí.");
	});
});

describe("useDevulturOptional", () => {
	let optional: ReturnType<typeof useDevulturOptional> | undefined;
	function OptionalProbe() {
		optional = useDevulturOptional();
		return null;
	}

	afterEach(() => {
		optional = undefined;
	});

	it("returns null outside a provider instead of throwing", () => {
		render(<OptionalProbe />);
		expect(optional).toBeNull();
	});

	it("returns what useDevultur returns under a provider", () => {
		renderViewer(<OptionalProbe />);
		expect(optional).toBe(latest);
	});
});
