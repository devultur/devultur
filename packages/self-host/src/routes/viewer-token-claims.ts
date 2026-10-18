import { coversScope, isWithinPathPrefix, relativeMediaPath, TokenScope } from "@devultur/core";
import { readTokenScopes } from "../token-claims";

// Claims that bind a verified viewer token to part of the bucket: `aud` = storage prefix it was issued under (without
// its trailing slash), `res` = path prefix its keys must fall under, `scope` = what it may do. `POST /v1/token` sets
// `aud` itself whenever the request has a storage prefix; an `issueCredential` plugin may add `res`. The delivery gate
// enforces each one that is present, whatever auth plugin runs in front. A token without a claim is not limited by it.

/** Code of every refusal of a valid token: which claim failed is logged, never told to the caller. */
export const TOKEN_REJECTED_CODE = "token_rejected";

export type ClaimRejectionReason = "audience" | "resource" | "scope";

export interface ClaimRejection {
	status: 403;
	error: string;
	code: typeof TOKEN_REJECTED_CODE;
	/** Which claim refused the token, for the server log only. */
	reason: ClaimRejectionReason;
}

interface ClaimTarget {
	/** Storage prefix of the current request, with or without its trailing slash. */
	storagePrefix: string | undefined;
	/** Requested virtual key (`{visibility}/{kind}/{id}/…`), relative to the storage prefix. */
	key: string;
}

function isOtherAudience(payload: Record<string, unknown>, storagePrefix: string | undefined): boolean {
	if (payload.aud === undefined) return false;
	return payload.aud !== (storagePrefix ?? "").replace(/\/$/, "");
}

function isOutsideResource(payload: Record<string, unknown>, key: string): boolean {
	if (payload.res === undefined) return false;
	if (typeof payload.res !== "string") return true;
	const relativePath = relativeMediaPath(key);
	return relativePath === null || !isWithinPathPrefix(relativePath, payload.res);
}

function lacksReadScope(payload: Record<string, unknown>): boolean {
	const scopes = readTokenScopes(payload);
	return scopes !== undefined && !coversScope(scopes, TokenScope.MEDIA_READ);
}

function rejectionReason(payload: Record<string, unknown>, target: ClaimTarget): ClaimRejectionReason | null {
	if (isOtherAudience(payload, target.storagePrefix)) return "audience";
	if (isOutsideResource(payload, target.key)) return "resource";
	if (lacksReadScope(payload)) return "scope";
	return null;
}

/** Why a verified token may not read `target.key`, or `null` when its claims allow it. Pure. */
export function viewerTokenClaimRejection(
	payload: Record<string, unknown>,
	target: ClaimTarget,
): ClaimRejection | null {
	const reason = rejectionReason(payload, target);
	if (!reason) return null;
	return { status: 403, error: "Token rejected", code: TOKEN_REJECTED_CODE, reason };
}
