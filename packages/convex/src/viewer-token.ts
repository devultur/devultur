import React from "react";
import { DEFAULT_TOKEN_EXPIRY_SECONDS } from "@devultur/core";
import { convexToJson, type JSONValue, type Value } from "convex/values";

/** What a viewer token action returns: the token with its lifetime, or the bare token (default lifetime). */
export type ViewerTokenResult = { token: string; expiresIn: number } | string;

/** Extra arguments sent with `sessionSecret` to the viewer token action. */
export type ViewerTokenArgs = Record<string, Value>;

type IssueViewerToken = (args: ViewerTokenArgs & { sessionSecret: string }) => Promise<ViewerTokenResult>;

interface UseViewerTokenOptions {
	issueViewerToken: IssueViewerToken;
	sessionSecret: string;
	tokenArgs?: ViewerTokenArgs;
}

interface IssuedToken {
	token: string;
	argsKey: string;
}

interface Issuance {
	argsKey: string;
	promise: Promise<string | null>;
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MIN_REFRESH_MS = 60_000;
const DEFAULT_TTL_MS = DEFAULT_TOKEN_EXPIRY_SECONDS * 1000;

function extractTokenResult(result: ViewerTokenResult) {
	const tokenValue = typeof result === "string" ? result : result.token;
	const ttlMs = typeof result === "string" ? DEFAULT_TTL_MS : result.expiresIn * 1000;
	return { tokenValue, ttlMs };
}

function sortKeys(json: JSONValue): JSONValue {
	if (Array.isArray(json)) return json.map(sortKeys);
	if (json === null || typeof json !== "object") return json;
	return Object.fromEntries(
		Object.keys(json)
			.sort()
			.map((name) => [name, sortKeys(json[name])]),
	);
}

/** Stable JSON of the token args: the same values in any key order give the same key. */
export function tokenArgsKey(tokenArgs: ViewerTokenArgs | undefined): string {
	return JSON.stringify(sortKeys(convexToJson(tokenArgs ?? {})));
}

/**
 * Issues the viewer token for the current `tokenArgs`, renews it before it expires, and re-issues it on demand
 * (single-flight). When `tokenArgs` change, the current token is dropped and a new one is issued; a response for
 * arguments that are no longer current is ignored.
 */
export function useViewerToken({ issueViewerToken, sessionSecret, tokenArgs }: UseViewerTokenOptions) {
	const argsKey = tokenArgsKey(tokenArgs);
	// biome-ignore lint/correctness/useExhaustiveDependencies: tokenArgs are compared by their stable JSON, not identity
	const stableArgs = React.useMemo(() => tokenArgs ?? {}, [argsKey]);
	const [issued, setIssued] = React.useState<IssuedToken | null>(null);
	const token = issued?.argsKey === argsKey ? issued.token : null;
	const currentArgsKeyRef = React.useRef(argsKey);
	const refreshTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const inFlightRef = React.useRef<Issuance | null>(null);

	React.useEffect(() => {
		currentArgsKeyRef.current = argsKey;
	}, [argsKey]);

	React.useEffect(() => {
		return () => {
			if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
		};
	}, []);

	const request = React.useCallback((): Promise<string | null> => {
		const renew = () => void request();
		return issueViewerToken({ ...stableArgs, sessionSecret }).then((result) => {
			if (currentArgsKeyRef.current !== argsKey) return null;
			const { tokenValue, ttlMs } = extractTokenResult(result);
			setIssued({ token: tokenValue, argsKey });
			if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
			refreshTimerRef.current = setTimeout(renew, Math.max(ttlMs - REFRESH_BUFFER_MS, MIN_REFRESH_MS));
			return tokenValue;
		});
	}, [issueViewerToken, stableArgs, argsKey, sessionSecret]);

	// Single-flight per arguments: concurrent calls share one issuance; one for stale arguments isn't shared.
	const issueOnce = React.useCallback((): Promise<string | null> => {
		const inFlight = inFlightRef.current;
		if (inFlight?.argsKey === argsKey) return inFlight.promise;
		const promise = request();
		const settle = () => {
			if (inFlightRef.current?.promise === promise) inFlightRef.current = null;
		};
		promise.then(settle, settle);
		inFlightRef.current = { argsKey, promise };
		return promise;
	}, [request, argsKey]);

	React.useEffect(() => {
		if (token) return;
		issueOnce();
	}, [token, issueOnce]);

	const reissueToken = React.useCallback((): Promise<string | null> => issueOnce().catch(() => null), [issueOnce]);

	return { token, reissueToken };
}
