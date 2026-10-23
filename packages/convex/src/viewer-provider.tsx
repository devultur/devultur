"use client";

import React from "react";
import { useAction } from "convex/react";
import { DevulturCapabilityError } from "./capability-error";
import { DevulturContext, type DevulturContextValue } from "./devultur-context";
import { useMediaSession, type ViewerTokenAction } from "./media-session";
import type { IssueViewerToken, ViewerTokenArgs } from "./viewer-token";

export interface DevulturViewerProviderProps {
	/** Media worker base (e.g. `https://media.your-domain.com`). */
	baseUrl: string;
	/**
	 * Your viewer token action. It receives `{ sessionSecret, ...tokenArgs }`, like `<DevulturProvider>`'s, and is
	 * called only once a private media is shown. Leave it out when every media is public: the provider then needs no
	 * Convex client, and a private media fails with `token_unavailable`.
	 */
	issueViewerToken?: ViewerTokenAction;
	/** Extra arguments for `issueViewerToken`, compared by value (see `<DevulturProvider tokenArgs>`). */
	tokenArgs?: ViewerTokenArgs;
	children: React.ReactNode;
}

const VIEWER_ACTIONS: Pick<DevulturContextValue, "uploadUrl" | "upload" | "deleteMedia"> = {
	uploadUrl: () => Promise.reject(new DevulturCapabilityError("uploadUrl")),
	upload: () => Promise.reject(new DevulturCapabilityError("upload")),
	deleteMedia: () => {
		throw new DevulturCapabilityError("deleteMedia");
	},
};

const NO_TOKEN_ACTION: IssueViewerToken = () =>
	Promise.reject(new Error("<DevulturViewerProvider> has no `issueViewerToken`: private media can't be shown"));

/**
 * A provider for apps that only display media: `<Image>`, `<Preview>`, `<DownloadLink>`, `useMediaObjectUrl` and the
 * video hooks work, and it needs no upload or delete actions. The viewer token is issued only when a private media is
 * shown, and renewed from then on; with only public media, nothing is issued. Without `issueViewerToken` it needs no
 * Convex client at all. `upload`, `uploadUrl` and `deleteMedia` throw a `DevulturCapabilityError`, as do the hooks that
 * need the `api` (`useMediaUpload`, `useDevulturApi`, `<MediaLibrary>`, `<MediaPicker>`).
 *
 * @example
 * <DevulturViewerProvider baseUrl={MEDIA_URL} issueViewerToken={api.admin.issueViewerToken} tokenArgs={{ workspaceId }}>
 *   <Preview media={document.file} />
 * </DevulturViewerProvider>
 *
 * // Only public media: no token action, no Convex client.
 * <DevulturViewerProvider baseUrl={MEDIA_URL}>
 *   <Image media={post.cover} alt="" />
 * </DevulturViewerProvider>
 */
export function DevulturViewerProvider({ issueViewerToken, ...props }: DevulturViewerProviderProps) {
	// Two components, so `useAction` (which needs a Convex client) only runs when there's an action to call.
	if (!issueViewerToken) return <ViewerSession issueViewerToken={NO_TOKEN_ACTION} {...props} />;
	return <ConvexViewerSession issueViewerToken={issueViewerToken} {...props} />;
}

type ViewerSessionProps = Omit<DevulturViewerProviderProps, "issueViewerToken">;

function ConvexViewerSession({
	issueViewerToken,
	...props
}: ViewerSessionProps & { issueViewerToken: ViewerTokenAction }) {
	const issueViewerTokenAction = useAction(issueViewerToken);
	return <ViewerSession issueViewerToken={issueViewerTokenAction} {...props} />;
}

function ViewerSession({
	baseUrl,
	issueViewerToken,
	tokenArgs,
	children,
}: ViewerSessionProps & { issueViewerToken: IssueViewerToken }) {
	const session = useMediaSession({ issueViewerToken, tokenArgs, baseUrl, isLazy: true });
	const devulturValue = React.useMemo(() => ({ ...session, ...VIEWER_ACTIONS }), [session]);
	return <DevulturContext value={devulturValue}>{children}</DevulturContext>;
}
