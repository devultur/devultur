// Shared by the media library tests: a `usePaginatedQuery` stand-in that records each call and answers with
// `paginated.answer(call)` (or throws `paginated.error`).
import { vi } from "vitest";
import type { MediaRecord } from "./types";

export interface PaginatedCall {
	reference: string;
	args: Record<string, unknown>;
	initialNumItems: number;
}

export interface PaginatedAnswer {
	results: MediaRecord[];
	status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
}

export const paginated = {
	calls: [] as PaginatedCall[],
	answer: (_call: PaginatedCall): PaginatedAnswer => ({ results: [], status: "Exhausted" }),
	error: null as Error | null,
	loadMore: vi.fn<(numItems: number) => void>(),
	reset() {
		this.calls = [];
		this.answer = () => ({ results: [], status: "Exhausted" });
		this.error = null;
		this.loadMore = vi.fn();
	},
};

export function convexReactMock() {
	return {
		useAction: () => async () => ({ token: "viewer-token", expiresIn: 3600 }),
		useMutation: () => async () => null,
		useQuery: () => undefined,
		useConvex: () => ({}),
		usePaginatedQuery: (reference: string, args: Record<string, unknown>, options: { initialNumItems: number }) => {
			const call = { reference, args, initialNumItems: options.initialNumItems };
			paginated.calls.push(call);
			if (paginated.error) throw paginated.error;
			const answer = paginated.answer(call);
			const isLoading = answer.status === "LoadingFirstPage" || answer.status === "LoadingMore";
			return { ...answer, isLoading, loadMore: paginated.loadMore };
		},
	};
}

export const LIBRARY_API = {
	issueViewerToken: "issueViewerToken",
	createUploadUrl: "createUploadUrl",
	deleteMedia: "deleteMedia",
	listMediaPage: "listMediaPage",
	searchMedia: "searchMedia",
};

export function record(key: string, overrides: Partial<MediaRecord> = {}): MediaRecord {
	return {
		key,
		type: "file",
		filename: `${key}.txt`,
		contentType: "text/plain",
		sizeBytes: 2048,
		visibility: "public",
		objectKey: `public/file/${key}/${key}.txt`,
		createdAt: 0,
		...overrides,
	};
}
