import { computeFingerprint, DEFAULT_SECURITY, TokenScope } from "@devultur/core";
import { Hono } from "hono";
import { SERVICE_SUBJECT_PREFIX, signViewerToken } from "../helpers";
import { cappedExpiry, decideCredential, withPluginClaims } from "../plugin-hooks";
import { getRequestState } from "../request-state";
import { audienceClaim, hasInvalidScope, scopeClaim } from "../token-claims";
import type { TokenRequest, WorkerApp } from "../types";
import { handleUploadToken } from "./token-upload";

const DEFAULT_VIEWER_TOKEN_TTL_SECONDS = 7200;

const token = new Hono<WorkerApp>();

token.post("/", async (context) => {
	const body = await context.req.json<TokenRequest>();

	if (!body.userId) {
		return context.json({ error: "userId is required" }, 400);
	}
	// The service subject is reserved, so a viewer token can never pass as the service token.
	if (typeof body.userId === "string" && body.userId.startsWith(SERVICE_SUBJECT_PREFIX)) {
		return context.json(
			{ error: `userId must not start with "${SERVICE_SUBJECT_PREFIX}"`, code: "reserved_user_id" },
			400,
		);
	}

	const clientIp = context.req.header("CF-Connecting-IP") ?? context.req.header("X-Forwarded-For") ?? "unknown";

	// The `issueCredential` hook decides whether to issue it (e.g. never more scopes than the requesting credential
	// has) and caps the expiry. Without a hook, the token carries whatever the client asks for.
	const requestedScopes = body.scopes ?? [TokenScope.MEDIA_READ];
	if (!Array.isArray(requestedScopes) || hasInvalidScope(requestedScopes)) {
		return context.json({ error: "scopes must be non-empty strings without spaces", code: "invalid_scopes" }, 400);
	}
	const now = Math.floor(Date.now() / 1000);
	const requestedExp = now + (body.expiresIn ?? DEFAULT_VIEWER_TOKEN_TTL_SECONDS);
	const decision = await decideCredential(context, {
		kind: "viewer",
		scopes: requestedScopes,
		expiresAt: requestedExp * 1000,
	});
	if (!decision.allow) return decision.response;
	const exp = cappedExpiry(requestedExp, decision.expiresAt, (epochMs) => Math.floor(epochMs / 1000));
	const expiresIn = exp - now;

	// L3: two fingerprints in the same token — `fp` (session) and `fpip` (session + IP). The gate checks
	// whichever the resource requires. The fingerprint is tied to the `sessionSecret` the CLIENT generates (not
	// the User-Agent): that way it still works when the token is issued server-side, and it's real binding. Empty
	// → no effective binding (delivery without the header also gives empty → they match). The `nonce` makes it unique per token.
	const sessionSecret = body.sessionSecret ?? "";
	const nonce = crypto.randomUUID();
	const fp = await computeFingerprint(body.userId, sessionSecret, nonce);
	const fpip = await computeFingerprint(body.userId, sessionSecret, nonce, clientIp);
	const scope = getRequestState(context);
	const security = scope.config?.security ?? DEFAULT_SECURITY;

	const payload = withPluginClaims(
		{
			sub: body.userId,
			ip: clientIp,
			nonce,
			fp,
			fpip,
			// Current binding policy → the gate knows what it can require without re-reading config.
			bind: { sessionBinding: security.sessionBinding ?? true, ipBinding: security.ipBinding ?? false },
			...scopeClaim(requestedScopes),
			// The storage prefix it was issued under: the delivery gate rejects the token under any other.
			...audienceClaim(scope.storagePrefix),
			iat: now,
			exp,
		},
		decision,
	);

	const jwt = await signViewerToken(payload, context.env.DELIVERY_SIGN_SECRET);

	return context.json({ token: jwt, expiresIn, expiresAt: exp });
});

// Upload token bound to a prefix (CI), see token-upload.ts. Download links: the `downloadLinks()` plugin.
token.post("/upload", handleUploadToken);

export { token };
