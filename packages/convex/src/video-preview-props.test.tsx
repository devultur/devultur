// @vitest-environment jsdom

import type { DevulturMedia } from "@devultur/core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The player is a stand-in that records its props: these tests are about what `<Preview>` hands it, and when.
const { playerProps, tokenGate } = vi.hoisted(() => ({
	playerProps: [] as Array<Record<string, unknown>>,
	tokenGate: { release: (_token: string) => {} },
}));
vi.mock("@devultur/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("@devultur/react")>()),
	VideoPlayer: (props: Record<string, unknown>) => {
		playerProps.push(props);
		return <span>Player</span>;
	},
}));
vi.mock("convex/react", () => ({
	useAction: () => () =>
		new Promise((resolve) => {
			tokenGate.release = (token) => resolve({ token, expiresIn: 3600 });
		}),
	useMutation: () => vi.fn(),
	useQuery: () => undefined,
	useConvex: () => ({}),
}));

const { DevulturProvider, Preview } = await import("./react");

const api = { issueViewerToken: "issueViewerToken", createUploadUrl: "createUploadUrl", deleteMedia: "deleteMedia" };
const privateVideo: DevulturMedia = { id: "v1", kind: "video", visibility: "private" };
const publicVideo: DevulturMedia = { id: "v2", kind: "video", visibility: "public" };

function renderPreview(media: DevulturMedia, metrics?: boolean) {
	return render(
		<DevulturProvider api={api as never} baseUrl="https://media.example">
			<Preview media={media} metrics={metrics} loading={<span>Loading video</span>} />
		</DevulturProvider>,
	);
}

afterEach(() => {
	cleanup();
	playerProps.length = 0;
});

describe("<Preview> video", () => {
	it("doesn't render a private video's player until its token exists", async () => {
		renderPreview(privateVideo);

		expect(screen.getByText("Loading video")).toBeTruthy();
		expect(playerProps).toHaveLength(0);

		await act(async () => tokenGate.release("viewer-token"));
		await waitFor(() => expect(screen.getByText("Player")).toBeTruthy());
		expect(playerProps.every((props) => props.token === "viewer-token")).toBe(true);
	});

	it("renders a public video's player right away", () => {
		renderPreview(publicVideo);
		expect(screen.getByText("Player")).toBeTruthy();
	});

	it("passes metrics to the player", () => {
		renderPreview(publicVideo, false);
		expect(playerProps.at(-1)?.metrics).toBe(false);

		cleanup();
		renderPreview(publicVideo);
		expect(playerProps.at(-1)?.metrics).toBeUndefined();
	});
});
