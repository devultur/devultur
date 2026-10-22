// @vitest-environment jsdom

import type { DevulturMedia } from "@devultur/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devulturErrorLabels as spanishErrorLabels } from "./locales/es";

const { calls } = vi.hoisted(() => ({ calls: [] as Array<{ reference: string; args: unknown }> }));
vi.mock("convex/react", () => ({
	useAction: (reference: string) => async (args: unknown) => {
		calls.push({ reference, args });
		return { token: "viewer-token", expiresIn: 3600 };
	},
	useMutation: () => vi.fn(),
	useQuery: () => undefined,
	useConvex: () => ({}),
	usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
}));

const { DevulturCapabilityError, DevulturViewerProvider, Preview, useDevultur, useDevulturApi, useMediaUpload } =
	await import("./react");
const { describeDevulturError } = await import("./error-labels");

const BASE_URL = "https://media.example";
const privateFile: DevulturMedia = { id: "f1", kind: "file", visibility: "private", filename: "notes.txt" };

let latest: ReturnType<typeof useDevultur> | null = null;
function Probe() {
	latest = useDevultur();
	return null;
}

function renderViewer(children: React.ReactNode) {
	return render(
		<DevulturViewerProvider
			baseUrl={BASE_URL}
			issueViewerToken={"admin.issueViewerToken" as never}
			tokenArgs={{ workspaceId: "w1" }}
		>
			<Probe />
			{children}
		</DevulturViewerProvider>,
	);
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

	it("describes the capability error in English and Spanish", () => {
		const error = new DevulturCapabilityError("upload");
		expect(describeDevulturError(error)).toBe("This app can't do that here.");
		expect(describeDevulturError(error, spanishErrorLabels)).toBe("Esta aplicación no puede hacer eso aquí.");
	});
});
