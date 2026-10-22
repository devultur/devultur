"use client";

// Lifecycle shared by `useMediaObjectUrl` and `<Preview>`'s text view: fetch once per media while enabled, abort
// the in-flight fetch and release what was built from it (an object URL) when the media changes or on unmount.
import React from "react";
import { type DevulturMedia, mediaPath, mediaUrl } from "@devultur/core";
import { loadMedia } from "./media-fetch";
import { useDevultur } from "./react";

export interface MediaResourceOptions<Value> {
	isEnabled: boolean;
	maxBytes?: number;
	/** Expected content type: the response must agree with it (see `trustedContentType`). */
	contentType?: string;
	/** Builds the value from the body. Only called while still mounted on the same media. */
	decode: (bytes: Uint8Array<ArrayBuffer>, contentType: string) => Value;
	/** Releases a value that is no longer shown. */
	release?: (value: Value) => void;
}

export interface MediaResourceState<Value> {
	value: Value | null;
	contentType: string | null;
	isLoading: boolean;
	error: Error | null;
}

interface Settled<Value> extends MediaResourceState<Value> {
	requestKey: string;
}

const IDLE = { value: null, contentType: null, isLoading: false, error: null } as const;
const LOADING = { value: null, contentType: null, isLoading: true, error: null } as const;

export function useMediaResource<Value>(
	media: DevulturMedia | null | undefined,
	options: MediaResourceOptions<Value>,
): MediaResourceState<Value> {
	const devultur = useDevultur();
	const { isEnabled, maxBytes, contentType } = options;
	const isPrivate = media?.visibility === "private";
	// Private delivery waits for the first viewer token; later renewals don't refetch (a PDF being read stays put).
	const isReady = !isPrivate || devultur.token !== null;
	// Everything that changes what is fetched or how it's trusted: a new value revokes the old one and refetches.
	const requestKey =
		media && isEnabled
			? [devultur.baseUrl, media.visibility, mediaPath(media), contentType ?? "", maxBytes ?? ""].join("|")
			: null;

	const [settled, setSettled] = React.useState<Settled<Value> | null>(null);
	// The latest inputs, read when the fetch starts, so a new token or callback identity doesn't restart it.
	const inputsRef = React.useRef({ media, devultur, options });
	React.useEffect(() => {
		inputsRef.current = { media, devultur, options };
	});

	React.useEffect(() => {
		if (!requestKey || !isReady) return;
		const { media: target, devultur: context, options: current } = inputsRef.current;
		if (!target || !context.baseUrl) return;
		const baseUrl = context.baseUrl;
		const controller = new AbortController();
		let value: Value | null = null;

		loadMedia({
			buildUrl: (viewerToken) => mediaUrl(baseUrl, target, { token: viewerToken }),
			token: context.token,
			sessionSecret: context.sessionSecret,
			reissueToken: context.reissueToken,
			isPrivate: target.visibility === "private",
			signal: controller.signal,
			maxBytes: current.maxBytes,
			contentType: current.contentType,
		})
			.then((loaded) => {
				if (controller.signal.aborted) return;
				value = current.decode(loaded.bytes, loaded.contentType);
				setSettled({ requestKey, value, contentType: loaded.contentType, isLoading: false, error: null });
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted) return;
				const failure = error instanceof Error ? error : new Error(String(error));
				setSettled({ requestKey, value: null, contentType: null, isLoading: false, error: failure });
			});

		return () => {
			controller.abort();
			if (value !== null) current.release?.(value);
		};
	}, [requestKey, isReady]);

	if (!requestKey) return IDLE;
	if (!devultur.baseUrl) throw new Error("Devultur media previews require `baseUrl` on <DevulturProvider>");
	if (settled?.requestKey !== requestKey) return LOADING;
	return { value: settled.value, contentType: settled.contentType, isLoading: false, error: settled.error };
}
