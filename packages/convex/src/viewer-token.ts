import React from "react";
import { DEFAULT_TOKEN_EXPIRY_SECONDS } from "@devultur/core";
import { convexToJson, type JSONValue, type Value } from "convex/values";

/** What a viewer token action returns: the token with its lifetime, or the bare token (default lifetime). */
export type ViewerTokenResult = { token: string; expiresIn: number } | string;

/** Extra arguments sent with `sessionSecret` to the viewer token action. */
export type ViewerTokenArgs = Record<string, Value>;

/**
 * Where the viewer token for the current `tokenArgs` stands: not requested yet, being issued (no token yet), held, or
 * failed (the action threw or returned no token). A renewal in flight, or one that failed, keeps `"ready"`.
 */
export type TokenStatus = "idle" | "loading" | "ready" | "error";

export type IssueViewerToken = (
	args: ViewerTokenArgs & { sessionSecret: string },
) => Promise<ViewerTokenResult | null | undefined>;

interface UseViewerTokenOptions {
	issueViewerToken: IssueViewerToken;
	sessionSecret: string;
	tokenArgs?: ViewerTokenArgs;
	/** `true` → nothing is issued until `requestToken()` is called (a private media needs it). Default `false`. */
	isLazy?: boolean;
}

interface IssuedToken {
	token: string;
	argsKey: string;
}

interface Issuance {
	argsKey: string;
	promise: Promise<string | null>;
}

/** The last issuance for some arguments that hasn't produced a token: in flight, or failed. */
type Attempt = { argsKey: string; status: "loading" } | { argsKey: string; status: "error"; error: Error };

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MIN_REFRESH_MS = 60_000;
const DEFAULT_TTL_MS = DEFAULT_TOKEN_EXPIRY_SECONDS * 1000;

function extractTokenResult(result: ViewerTokenResult | null | undefined) {
	const tokenValue = typeof result === "string" ? result : result?.token;
	if (typeof tokenValue !== "string" || tokenValue === "") {
		throw new Error("The viewer token action returned no token");
	}
	const expiresIn = typeof result === "object" ? result?.expiresIn : undefined;
	const ttlMs = typeof expiresIn === "number" ? expiresIn * 1000 : DEFAULT_TTL_MS;
	return { tokenValue, ttlMs };
}

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

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
 * arguments that are no longer current is ignored. A failed issuance isn't retried on its own: `retryToken` does.
 * Lazy, the first issuance waits for `requestToken()`; once requested, the token is kept and renewed like an eager one.
 */
export function useViewerToken({ issueViewerToken, sessionSecret, tokenArgs, isLazy = false }: UseViewerTokenOptions) {
	const argsKey = tokenArgsKey(tokenArgs);
	// biome-ignore lint/correctness/useExhaustiveDependencies: tokenArgs are compared by their stable JSON, not identity
	const stableArgs = React.useMemo(() => tokenArgs ?? {}, [argsKey]);
	const [issued, setIssued] = React.useState<IssuedToken | null>(null);
	const [attempt, setAttempt] = React.useState<Attempt | null>(null);
	const [isRequested, setIsRequested] = React.useState(!isLazy);
	const token = issued?.argsKey === argsKey ? issued.token : null;
	const currentAttempt = attempt?.argsKey === argsKey ? attempt : null;
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

	const request = React.useCallback(async (): Promise<string | null> => {
		const renew = () => {
			request().catch((error: unknown) => console.warn("Devultur: could not renew the viewer token", error));
		};
		const result = await issueViewerToken({ ...stableArgs, sessionSecret });
		if (currentArgsKeyRef.current !== argsKey) return null;
		const { tokenValue, ttlMs } = extractTokenResult(result);
		setIssued({ token: tokenValue, argsKey });
		setAttempt(null);
		if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
		refreshTimerRef.current = setTimeout(renew, Math.max(ttlMs - REFRESH_BUFFER_MS, MIN_REFRESH_MS));
		return tokenValue;
	}, [issueViewerToken, stableArgs, argsKey, sessionSecret]);

	// Single-flight per arguments: concurrent calls share one issuance; one for stale arguments isn't shared.
	const issueOnce = React.useCallback((): Promise<string | null> => {
		const inFlight = inFlightRef.current;
		if (inFlight?.argsKey === argsKey) return inFlight.promise;
		setAttempt({ argsKey, status: "loading" });
		const promise = request().catch((error: unknown) => {
			if (currentArgsKeyRef.current === argsKey) setAttempt({ argsKey, status: "error", error: asError(error) });
			throw error;
		});
		const settle = () => {
			if (inFlightRef.current?.promise === promise) inFlightRef.current = null;
		};
		promise.then(settle, settle);
		inFlightRef.current = { argsKey, promise };
		return promise;
	}, [request, argsKey]);

	// The first issuance per arguments. After a failure it waits for `retryToken`, so a broken action isn't hammered.
	const hasAttempt = currentAttempt !== null;
	React.useEffect(() => {
		if (!isRequested || token || hasAttempt) return;
		issueOnce().catch(() => {});
	}, [isRequested, token, hasAttempt, issueOnce]);

	// Stable, and a no-op once requested: a render may call it for every private media it shows.
	const requestToken = React.useCallback(() => setIsRequested(true), []);

	// Called when the delivery refused the token (`session_mismatch`): when no new one comes, the old one is useless.
	const reissueToken = React.useCallback(
		(): Promise<string | null> =>
			issueOnce().catch(() => {
				setIssued((current) => (current?.argsKey === argsKey ? null : current));
				return null;
			}),
		[issueOnce, argsKey],
	);

	const retryToken = React.useCallback((): Promise<string | null> => {
		setIsRequested(true);
		return issueOnce().catch(() => null);
	}, [issueOnce]);

	const tokenStatus: TokenStatus = token ? "ready" : (currentAttempt?.status ?? "idle");
	const tokenError = !token && currentAttempt?.status === "error" ? currentAttempt.error : null;

	return { token, tokenStatus, tokenError, reissueToken, retryToken, requestToken };
}
