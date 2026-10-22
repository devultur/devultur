// @vitest-environment jsdom

import type { DevulturMedia } from "@devultur/core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// A stand-in for hls.js: each instance records its `ERROR` handler so a test can report a refused request.
const { players, tokenCalls } = vi.hoisted(() => ({
	players: [] as Array<{ emitError: (data: unknown) => void; destroyed: boolean }>,
	tokenCalls: { count: 0 },
}));
// `@devultur/react` resolves hls.js from its own `node_modules` (this package doesn't depend on it).
vi.mock("../../react/node_modules/hls.js/dist/hls.mjs", () => {
	class FakeHls {
		static Events = { MANIFEST_PARSED: "manifestParsed", LEVEL_SWITCHED: "levelSwitched", ERROR: "hlsError" };
		static isSupported = () => true;
		levels = [];
		currentLevel = -1;
		private readonly record = { emitError: (_data: unknown) => {}, destroyed: false };
		constructor() {
			players.push(this.record);
		}
		private readonly errorHandlers: Array<(event: string, data: unknown) => void> = [];
		on(event: string, handler: (event: string, data: unknown) => void) {
			if (event !== "hlsError") return;
			this.errorHandlers.push(handler);
			this.record.emitError = (data) => {
				for (const errorHandler of this.errorHandlers) errorHandler(event, data);
			};
		}
		off() {}
		loadSource() {}
		attachMedia() {}
		destroy() {
			this.record.destroyed = true;
		}
	}
	return { default: FakeHls };
});

vi.mock("convex/react", () => ({
	useAction: () => async () => {
		tokenCalls.count += 1;
		return { token: `viewer-token-${tokenCalls.count}`, expiresIn: 3600 };
	},
	useMutation: () => vi.fn(),
	useQuery: () => undefined,
	useConvex: () => ({}),
}));

const { DevulturProvider, Preview } = await import("./react");

const api = { issueViewerToken: "issueViewerToken", createUploadUrl: "createUploadUrl", deleteMedia: "deleteMedia" };
const video: DevulturMedia = { id: "v1", kind: "video", visibility: "private" };

const unauthorized = (code?: string) => ({
	fatal: true,
	details: "manifestLoadError",
	response: { code: 401 },
	networkDetails: { response: code ? JSON.stringify({ code, message: "refused" }) : "" },
});

function renderVideo() {
	return render(
		<DevulturProvider api={api as never} baseUrl="https://media.example">
			<Preview media={video} fallback={(error) => <span>Fallback: {error.code}</span>} />
		</DevulturProvider>,
	);
}

afterEach(() => {
	cleanup();
	players.length = 0;
	tokenCalls.count = 0;
	vi.unstubAllGlobals();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
// The player is rebuilt for each new token: the live one is the last.
const livePlayer = () => players.filter((player) => !player.destroyed).at(-1)!;

async function renderPlayingVideo() {
	renderVideo();
	await waitFor(() => expect(tokenCalls.count).toBe(1));
	await settle();
}

describe("<Preview> video errors", () => {
	it("re-issues once on session_mismatch, then hands session_mismatch to the fallback", async () => {
		await renderPlayingVideo();

		act(() => livePlayer().emitError(unauthorized("session_mismatch")));
		await waitFor(() => expect(tokenCalls.count).toBe(2));
		await settle();
		expect(screen.queryByText(/Fallback/)).toBeNull();

		act(() => livePlayer().emitError(unauthorized("session_mismatch")));
		expect(await screen.findByText("Fallback: session_mismatch")).toBeTruthy();
	});

	it("hands token_unavailable to the fallback on another 401", async () => {
		await renderPlayingVideo();

		act(() => livePlayer().emitError(unauthorized("token_rejected")));
		expect(await screen.findByText("Fallback: token_unavailable")).toBeTruthy();
	});

	it("hands http_error to the fallback when the playlist never got an answer", async () => {
		await renderPlayingVideo();

		act(() => livePlayer().emitError({ fatal: true, details: "manifestLoadError" }));
		expect(await screen.findByText("Fallback: http_error")).toBeTruthy();
	});

	it("hands render_failed to the fallback when the video can't be played", async () => {
		await renderPlayingVideo();

		act(() => livePlayer().emitError({ fatal: true, details: "bufferAppendError" }));
		expect(await screen.findByText("Fallback: render_failed")).toBeTruthy();
	});

	it("keeps playing through errors hls.js recovers from", async () => {
		await renderPlayingVideo();

		act(() => livePlayer().emitError({ fatal: false, details: "fragLoadError", response: { code: 503 } }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.queryByText(/Fallback/)).toBeNull();
	});
});
