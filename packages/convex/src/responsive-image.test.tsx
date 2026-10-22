// @vitest-environment jsdom

import type React from "react";
import type { DevulturMedia } from "@devultur/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSrcSet, normalizeWidths, pickWidth, renderedWidthFromSizes, scaledHeight } from "./responsive-image";

const { actions } = vi.hoisted(() => ({ actions: new Map<string, (args: unknown) => Promise<unknown>>() }));
vi.mock("convex/react", () => ({
	useAction: (reference: string) => (args: unknown) => actions.get(reference)?.(args) ?? Promise.resolve(null),
	useMutation: () => vi.fn(),
	useQuery: () => undefined,
	useConvex: () => ({}),
}));

const { DevulturProvider, Image } = await import("./react");

const BASE_URL = "https://media.example";
const api = { issueViewerToken: "issueViewerToken", createUploadUrl: "createUploadUrl", deleteMedia: "deleteMedia" };
const publicImage: DevulturMedia = {
	id: "img1",
	kind: "image",
	visibility: "public",
	filename: "cover.png",
	width: 2400,
	height: 1600,
	alt: "A mountain",
};
const privateImage: DevulturMedia = { ...publicImage, visibility: "private" };
const imageUrl = `${BASE_URL}/v1/media/public/image/img1/cover.png`;

function renderWithDevultur(element: React.ReactElement) {
	return render(
		<DevulturProvider api={api as never} baseUrl={BASE_URL}>
			{element}
		</DevulturProvider>,
	);
}

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

beforeEach(() => {
	fetchMock = vi.fn(async () => new Response("bytes"));
	vi.stubGlobal("fetch", fetchMock);
	Object.assign(URL, { createObjectURL: vi.fn(() => "blob:media"), revokeObjectURL: vi.fn() });
	actions.set("issueViewerToken", async () => ({ token: "viewer-token", expiresIn: 3600 }));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	actions.clear();
});

describe("<Image widths> with public media", () => {
	it("builds a srcset from the Worker's transforms, with sizes, lazy loading and the intrinsic size", () => {
		renderWithDevultur(
			<Image media={publicImage} widths={[960, 480, 480, 1440]} sizes="(min-width: 768px) 50vw, 100vw" format="webp" />,
		);

		const image = screen.getByRole("img", { name: "A mountain" });
		expect(image.getAttribute("srcset")).toBe(
			`${imageUrl}?w=480&format=webp 480w, ${imageUrl}?w=960&format=webp 960w, ${imageUrl}?w=1440&format=webp 1440w`,
		);
		expect(image.getAttribute("src")).toBe(`${imageUrl}?w=1440&format=webp`);
		expect(image.getAttribute("sizes")).toBe("(min-width: 768px) 50vw, 100vw");
		expect(image.getAttribute("width")).toBe("2400");
		expect(image.getAttribute("height")).toBe("1600");
		expect(image.getAttribute("loading")).toBe("lazy");
		expect(image.getAttribute("decoding")).toBe("async");
	});

	it("keeps the width×height ratio on every variant", () => {
		renderWithDevultur(<Image media={publicImage} widths={[400, 800]} width={400} height={300} fit="cover" />);

		expect(screen.getByRole("img").getAttribute("srcset")).toBe(
			`${imageUrl}?w=400&h=300&fit=cover 400w, ${imageUrl}?w=800&h=600&fit=cover 800w`,
		);
	});

	it("lets the app override loading", () => {
		renderWithDevultur(<Image media={publicImage} widths={[400]} loading="eager" />);

		expect(screen.getByRole("img").getAttribute("loading")).toBe("eager");
	});
});

describe("<Image> without widths", () => {
	it("keeps a single src, with no srcset and no lazy defaults", () => {
		renderWithDevultur(<Image media={publicImage} width={512} format="webp" />);

		const image = screen.getByRole("img");
		expect(image.getAttribute("src")).toBe(`${imageUrl}?w=512&format=webp`);
		expect(image.hasAttribute("srcset")).toBe(false);
		expect(image.hasAttribute("loading")).toBe(false);
		expect(image.getAttribute("width")).toBe("512");
		expect(image.getAttribute("height")).toBe("1600");
	});
});

describe("<Image widths> with private media", () => {
	it("fetches one width, the largest up to twice the width `sizes` gives it", async () => {
		renderWithDevultur(<Image media={privateImage} widths={[320, 640, 960, 1280]} sizes="400px" />);

		const image = await screen.findByRole("img", { name: "A mountain" });
		expect(image.getAttribute("src")).toBe("blob:media");
		expect(image.hasAttribute("srcset")).toBe(false);
		expect(image.getAttribute("width")).toBe("2400");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get("w")).toBe("640");
	});

	it("fetches the largest width when nothing says how wide it renders", async () => {
		renderWithDevultur(<Image media={privateImage} widths={[320, 1280, 640]} />);

		await screen.findByRole("img");
		expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get("w")).toBe("1280");
	});
});

describe("responsive helpers", () => {
	it("normalizes widths", () => {
		expect(normalizeWidths([960, 0, 480, 480, -1, 1.5])).toEqual([480, 960]);
	});

	it("joins candidates", () => {
		expect(buildSrcSet([1, 2], (width) => `u${width}`)).toBe("u1 1w, u2 2w");
	});

	it("scales a height only with both dimensions", () => {
		expect(scaledHeight(800, 400, 300)).toBe(600);
		expect(scaledHeight(800, 400)).toBeUndefined();
	});

	it("picks the largest width up to 2× the rendered width, else the smallest", () => {
		expect(pickWidth([320, 640, 960], 400)).toBe(640);
		expect(pickWidth([320, 640, 960], 100)).toBe(320);
		expect(pickWidth([320, 640, 960], null)).toBe(960);
	});

	it("reads the matching entry of `sizes` in px or vw", () => {
		vi.stubGlobal("innerWidth", 1000);
		vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(min-width: 768px)" }));

		expect(renderedWidthFromSizes("(min-width: 768px) 50vw, 100vw")).toBe(500);
		expect(renderedWidthFromSizes("(min-width: 1200px) 600px, 320px")).toBe(320);
		expect(renderedWidthFromSizes("calc(100vw - 2rem)")).toBeNull();
		expect(renderedWidthFromSizes(undefined)).toBeNull();
	});
});
