// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("convex/react", () => ({
	useAction: () => async () => ({ token: "viewer-token", expiresIn: 3600 }),
	useMutation: () => vi.fn(),
	useQuery: () => undefined,
	useConvex: () => ({}),
}));

const { DevulturProvider, DevulturViewerProvider, useCanDeliver, useMediaUrl } = await import("./react");

const BASE_URL = "https://media.example";
const api = { issueViewerToken: "issueViewerToken", createUploadUrl: "createUploadUrl", deleteMedia: "deleteMedia" };

// What a shared component does with it: a delivery URL where the hooks can build one, a fallback elsewhere.
function Cover() {
	if (!useCanDeliver()) return <p>fallback</p>;
	return <MediaCover />;
}

function MediaCover() {
	return <p>{useMediaUrl("public/images/cover.png")}</p>;
}

afterEach(cleanup);

describe("useCanDeliver", () => {
	it("is false outside a provider", () => {
		render(<Cover />);

		expect(screen.getByText("fallback")).toBeDefined();
	});

	it.each([
		["without baseUrl", undefined],
		["with an empty baseUrl", ""],
	])("is false under <DevulturProvider> %s, where useMediaUrl throws", (_case, baseUrl) => {
		render(
			<DevulturProvider api={api as never} baseUrl={baseUrl}>
				<Cover />
			</DevulturProvider>,
		);

		expect(screen.getByText("fallback")).toBeDefined();
	});

	it("is true under <DevulturProvider> with a baseUrl", () => {
		render(
			<DevulturProvider api={api as never} baseUrl={BASE_URL}>
				<Cover />
			</DevulturProvider>,
		);

		expect(screen.getByText(`${BASE_URL}/v1/media/public/images/cover.png`)).toBeDefined();
	});

	it("is true under <DevulturViewerProvider>, even without a viewer token action", () => {
		render(
			<DevulturViewerProvider baseUrl={BASE_URL}>
				<Cover />
			</DevulturViewerProvider>,
		);

		expect(screen.getByText(`${BASE_URL}/v1/media/public/images/cover.png`)).toBeDefined();
	});
});
