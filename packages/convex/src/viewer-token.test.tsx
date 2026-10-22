// @vitest-environment jsdom

import { act, render, waitFor } from "@testing-library/react";
import type { Value } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenArgsKey } from "./viewer-token";

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

const api = {
	issueViewerToken: "issueViewerToken",
	createUploadUrl: "createUploadUrl",
	deleteMedia: "deleteMedia",
} as never;

interface Deferred {
	args: Record<string, unknown>;
	resolve: (token: string) => void;
}

/** Records every call to `reference`; each one resolves only when the test says so. */
function deferredAction(reference: string) {
	const calls: Deferred[] = [];
	actions.set(reference, (args) => {
		return new Promise((resolve) => {
			calls.push({ args: args as Record<string, unknown>, resolve: (token) => resolve({ token, expiresIn: 3600 }) });
		});
	});
	return calls;
}

interface HarnessProps {
	tokenArgs?: Record<string, Value>;
	issueViewerToken?: string;
}

let latest: ReturnType<typeof useDevultur> | null = null;

function Probe() {
	latest = useDevultur();
	return null;
}

function Harness({ tokenArgs, issueViewerToken }: HarnessProps) {
	return (
		<DevulturProvider api={api} tokenArgs={tokenArgs} issueViewerToken={issueViewerToken as never}>
			<Probe />
		</DevulturProvider>
	);
}

function renderProvider(props: HarnessProps) {
	const view = render(<Harness {...props} />);
	return { rerender: (next: HarnessProps) => view.rerender(<Harness {...next} />) };
}

afterEach(() => {
	actions.clear();
	latest = null;
});

describe("tokenArgsKey", () => {
	it("ignores key order", () => {
		expect(tokenArgsKey({ a: 1, b: { c: "x", d: 2 } })).toBe(tokenArgsKey({ b: { d: 2, c: "x" }, a: 1 }));
	});

	it("treats no args as empty args", () => {
		expect(tokenArgsKey(undefined)).toBe(tokenArgsKey({}));
	});
});

describe("DevulturProvider tokenArgs", () => {
	it("sends the args with the session secret on the first issuance", async () => {
		const calls = deferredAction("issueViewerToken");
		renderProvider({ tokenArgs: { workspaceId: "w1" } });

		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]!.args).toEqual({ workspaceId: "w1", sessionSecret: expect.any(String) });
		await act(async () => calls[0]!.resolve("token-w1"));
		expect(latest?.token).toBe("token-w1");
	});

	it("sends the args when re-issuing", async () => {
		const calls = deferredAction("issueViewerToken");
		renderProvider({ tokenArgs: { workspaceId: "w1" } });
		await waitFor(() => expect(calls).toHaveLength(1));
		await act(async () => calls[0]!.resolve("token-1"));

		let reissued: Promise<string | null> = Promise.resolve(null);
		act(() => {
			reissued = latest!.reissueToken();
		});
		expect(calls).toHaveLength(2);
		expect(calls[1]!.args).toMatchObject({ workspaceId: "w1" });
		await act(async () => calls[1]!.resolve("token-2"));
		await expect(reissued).resolves.toBe("token-2");
		expect(latest?.token).toBe("token-2");
	});

	it("drops the token and issues a new one when the args change", async () => {
		const calls = deferredAction("issueViewerToken");
		const { rerender } = renderProvider({ tokenArgs: { workspaceId: "w1" } });
		await waitFor(() => expect(calls).toHaveLength(1));
		await act(async () => calls[0]!.resolve("token-w1"));

		rerender({ tokenArgs: { workspaceId: "w2" } });
		expect(latest?.token).toBeNull();
		await waitFor(() => expect(calls).toHaveLength(2));
		expect(calls[1]!.args).toMatchObject({ workspaceId: "w2" });
		await act(async () => calls[1]!.resolve("token-w2"));
		expect(latest?.token).toBe("token-w2");
	});

	it("doesn't reissue when equal args arrive as a new object", async () => {
		const calls = deferredAction("issueViewerToken");
		const { rerender } = renderProvider({ tokenArgs: { workspaceId: "w1", role: "admin" } });
		await waitFor(() => expect(calls).toHaveLength(1));
		await act(async () => calls[0]!.resolve("token-w1"));

		rerender({ tokenArgs: { role: "admin", workspaceId: "w1" } });
		expect(latest?.token).toBe("token-w1");
		expect(calls).toHaveLength(1);
	});

	it("ignores a reissue that resolves after the args changed", async () => {
		const calls = deferredAction("issueViewerToken");
		const { rerender } = renderProvider({ tokenArgs: { workspaceId: "w1" } });
		await waitFor(() => expect(calls).toHaveLength(1));
		await act(async () => calls[0]!.resolve("token-w1"));

		let staleReissue: Promise<string | null> = Promise.resolve(null);
		act(() => {
			staleReissue = latest!.reissueToken();
		});
		rerender({ tokenArgs: { workspaceId: "w2" } });
		await waitFor(() => expect(calls).toHaveLength(3));
		await act(async () => calls[2]!.resolve("token-w2"));
		await act(async () => calls[1]!.resolve("token-w1-late"));

		await expect(staleReissue).resolves.toBeNull();
		expect(latest?.token).toBe("token-w2");
	});

	it("calls a custom action instead of api.issueViewerToken", async () => {
		const defaultCalls = deferredAction("issueViewerToken");
		const customCalls = deferredAction("admin.issueWorkspaceToken");
		renderProvider({ tokenArgs: { workspaceId: "w1" }, issueViewerToken: "admin.issueWorkspaceToken" });

		await waitFor(() => expect(customCalls).toHaveLength(1));
		expect(customCalls[0]!.args).toMatchObject({ workspaceId: "w1" });
		expect(defaultCalls).toHaveLength(0);
	});
});
