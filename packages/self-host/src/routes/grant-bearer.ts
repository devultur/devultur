// The bearer's side of a download grant (`/v1/grant`), authenticated by the grant itself, never by a URL:
// - `HEAD   /file`  → the file's head (size, sha256, expiry, `x-devultur-encrypted`) plus the grant's expiry and metadata.
// - `POST   /links` `{ expiresIn?, maxUses?, filename?, metadata? }` → `{ id, url, expiresAt, maxUses }`, within the caps.
// - `DELETE /file`  → deletes the file (lock guard: `409 retention_active`) when the grant allows it; its grants go too.
// - `DELETE /`      → revokes the grant. Idempotent.
// Every use but revoking checks that the grant belongs to the request's storage prefix, runs the `authorizeGrant`
// hooks, and re-reads the object: deleted, expired or overwritten since the grant → `410 grant_gone`.
import {
	DownloadGrantErrorCode,
	DownloadGrantLimits,
	ENCRYPTED_HEADER,
	GRANT_EXPIRES_AT_HEADER,
	GRANT_KEY_HEADER,
	GRANT_METADATA_HEADER,
	TokenScope,
} from "@devultur/core";
import { Hono } from "hono";
import { type DownloadGrantInfo, DownloadGrantPath } from "../download-grants";
import { formatGrantPublicId, hashGrantSecret, type ParsedGrantSecret, parseGrantSecret } from "../grant-credential";
import { cappedExpiry, decideCredential, type GrantAction, gateGrantAccess } from "../plugin-hooks";
import { getRequestState } from "../request-state";
import { addRouteResult } from "../route-result";
import type { WorkerApp } from "../types";
import { MAX_LINK_TTL_SECONDS, storeLink } from "./download";
import {
	callGrants,
	grantNamespaces,
	grantsObjectById,
	notConfigured,
	parseCount,
	parseMetadata,
	relayGrantFailure,
	type WorkerContext,
} from "./grant-shared";
import { deleteMediaKey } from "./media-delete";
import { applyIntegrityHeaders, isObjectExpired, objectExpiresAt } from "./object-response";
import { applyImageSizeHeaders } from "./upload-image-size";

interface Bearer {
	stub: DurableObjectStub;
	parsed: ParsedGrantSecret;
	secretHash: string;
	publicId: string;
}

interface AuthorizedGrant extends Bearer {
	grant: DownloadGrantInfo;
	object: R2Object;
}

const grantError = (status: number, code: string, error: string) => Response.json({ error, code }, { status });
const invalidGrant = () => grantError(401, DownloadGrantErrorCode.INVALID, "Invalid download grant");
const grantGone = () => grantError(410, DownloadGrantErrorCode.GONE, "This download grant is no longer valid");

/** The grant in `Authorization: Bearer`, or why there's none. A grant in `?token=` is refused, never used. */
async function readBearer(context: WorkerContext, grants: DurableObjectNamespace): Promise<Bearer | Response> {
	const bearer = context.req.header("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
	if (!bearer && context.req.query("token") !== undefined) {
		return grantError(401, DownloadGrantErrorCode.IN_QUERY, "Send the grant in Authorization: Bearer, never in a URL");
	}
	const parsed = bearer ? parseGrantSecret(bearer) : null;
	const stub = parsed ? grantsObjectById(grants, parsed.objectId) : null;
	if (!parsed || !stub) return invalidGrant();
	return {
		stub,
		parsed,
		secretHash: await hashGrantSecret(parsed.secret),
		publicId: formatGrantPublicId(parsed),
	};
}

/** The file of a live grant, or 410 if it's gone, expired or was overwritten (a missing file revokes its grants). */
async function grantedObject(context: WorkerContext, bearer: Bearer, grant: DownloadGrantInfo) {
	const object = await context.env.MEDIA_BUCKET.head(grant.storageKey);
	if (!object) {
		await callGrants(bearer.stub, DownloadGrantPath.REVOKE_ALL);
		return grantGone();
	}
	if (object.version !== grant.version || isObjectExpired(object.customMetadata)) return grantGone();
	return object;
}

/** The bearer's live grant over a file that's still there, after the `authorizeGrant` hooks. */
async function authorizeGrant(context: WorkerContext, action: GrantAction): Promise<AuthorizedGrant | Response> {
	const namespaces = grantNamespaces(context);
	if (!namespaces) return notConfigured(context);
	const bearer = await readBearer(context, namespaces.grants);
	if (bearer instanceof Response) return bearer;
	const authorized = await callGrants(bearer.stub, DownloadGrantPath.AUTHORIZE, {
		id: bearer.parsed.grantId,
		secretHash: bearer.secretHash,
	});
	if (!authorized.ok) return relayGrantFailure(authorized);
	const grant = (await authorized.json()) as DownloadGrantInfo;
	// Another tenant's grant is not a grant here.
	if (grant.storagePrefix !== getRequestState(context).storagePrefix) return invalidGrant();
	const refusal = await gateGrantAccess(context, { action, grant });
	if (refusal) return refusal;
	const object = await grantedObject(context, bearer, grant);
	if (object instanceof Response) return object;
	return { ...bearer, grant, object };
}

function headHeaders({ grant, object }: AuthorizedGrant): Headers {
	const headers = new Headers({
		"Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
		"Content-Length": String(object.size),
		ETag: object.httpEtag,
		"Cache-Control": "private, no-store",
		[ENCRYPTED_HEADER]: object.customMetadata?.enc ? "true" : "false",
		[GRANT_EXPIRES_AT_HEADER]: String(grant.expiresAt),
		[GRANT_KEY_HEADER]: grant.key,
	});
	applyIntegrityHeaders(headers, object.customMetadata);
	applyImageSizeHeaders(headers, object.customMetadata);
	if (grant.metadata) headers.set(GRANT_METADATA_HEADER, encodeURIComponent(JSON.stringify(grant.metadata)));
	return headers;
}

async function handleHead(context: WorkerContext): Promise<Response> {
	// Hono routes HEAD to the GET handler: the bytes are only reachable through a link.
	if (context.req.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "HEAD" } });
	const authorized = await authorizeGrant(context, "head");
	if (authorized instanceof Response) return authorized;
	return new Response(null, { status: 200, headers: headHeaders(authorized) });
}

interface LinkRequestBody {
	expiresIn?: unknown;
	maxUses?: unknown;
	filename?: unknown;
	metadata?: unknown;
}

interface ParsedLinkRequest {
	expiresIn: number;
	maxUses: number;
	filename?: string;
	metadata?: Record<string, string>;
}

/** The link request, or why it's invalid. The grant's caps are checked by the `DownloadGrants` object. Pure. */
export function parseGrantLinkRequest(body: LinkRequestBody, grant: DownloadGrantInfo) {
	const defaultExpiresIn = Math.min(DownloadGrantLimits.DEFAULT_LINK_EXPIRES_IN, grant.link.maxExpiresIn);
	const expiresIn = parseCount(body.expiresIn, defaultExpiresIn, MAX_LINK_TTL_SECONDS);
	if (expiresIn === null)
		return { error: "expiresIn must be a positive number of seconds", code: "invalid_expires_in" };
	const maxUses = parseCount(body.maxUses, 1, Number.MAX_SAFE_INTEGER);
	if (maxUses === null) return { error: "maxUses must be a positive integer", code: "invalid_max_uses" };
	const metadata = parseMetadata(body.metadata, DownloadGrantLimits.MAX_METADATA_BYTES);
	if (metadata === null)
		return { error: "metadata must map strings to strings, 1 KB at most", code: "invalid_metadata" };
	const filename = typeof body.filename === "string" && body.filename ? body.filename : undefined;
	const parsed: ParsedLinkRequest = {
		expiresIn,
		maxUses,
		...(filename ? { filename } : {}),
		...(metadata ? { metadata } : {}),
	};
	return parsed;
}

async function handleIssueLink(context: WorkerContext): Promise<Response> {
	const namespaces = grantNamespaces(context);
	if (!namespaces) return notConfigured(context);
	const authorized = await authorizeGrant(context, "issue-link");
	if (authorized instanceof Response) return authorized;
	const { grant, object, stub } = authorized;
	const parsed = parseGrantLinkRequest(((await context.req.json().catch(() => null)) ?? {}) as LinkRequestBody, grant);
	if ("error" in parsed) return context.json(parsed, 400);

	const requestedExpiresAt = Math.min(
		Date.now() + parsed.expiresIn * 1000,
		objectExpiresAt(object.customMetadata) ?? Number.POSITIVE_INFINITY,
		grant.expiresAt,
	);
	const decision = await decideCredential(context, {
		kind: "download-link",
		scopes: [TokenScope.MEDIA_READ],
		path: grant.key,
		expiresAt: requestedExpiresAt,
	});
	if (!decision.allow) return decision.response;

	// The spend is atomic in the grant's object; caps over the grant's spend nothing.
	const credential = { id: authorized.parsed.grantId, secretHash: authorized.secretHash };
	const spent = await callGrants(stub, DownloadGrantPath.ISSUE, { ...credential, ...parsed });
	if (!spent.ok) return relayGrantFailure(spent);

	const expiresAt = cappedExpiry(requestedExpiresAt, decision.expiresAt, (epochMs) => epochMs);
	const created = await storeLink(context, namespaces.links, {
		storageKey: grant.storageKey,
		key: grant.key,
		expiresAt,
		maxUses: parsed.maxUses,
		...(parsed.filename ? { filename: parsed.filename } : {}),
		storagePrefix: grant.storagePrefix,
		...(grant.context ? { context: grant.context } : {}),
		grantId: authorized.publicId,
		...(parsed.metadata ? { metadata: parsed.metadata } : {}),
	});
	if (!created) {
		await callGrants(stub, DownloadGrantPath.REFUND, { id: credential.id });
		return context.json({ error: "Could not create the download link" }, 500);
	}
	return context.json({ ...created, expiresAt, maxUses: parsed.maxUses });
}

async function handleDeleteFile(context: WorkerContext): Promise<Response> {
	const authorized = await authorizeGrant(context, "delete-file");
	if (authorized instanceof Response) return authorized;
	const { grant, stub, publicId } = authorized;
	if (!grant.canDelete) {
		return grantError(403, DownloadGrantErrorCode.CANNOT_DELETE, "This download grant can't delete its file");
	}
	const deleted = await deleteMediaKey(context, grant.key);
	if (deleted.status !== 204) return deleted;
	// The file is gone: every grant of it answers 410 from now on.
	await callGrants(stub, DownloadGrantPath.REVOKE_ALL);
	addRouteResult(context, {
		grantDeletedKey: grant.key,
		revokedGrant: { publicId, grant: { ...grant, revokedAt: Date.now() }, by: "bearer" },
	});
	return deleted;
}

async function handleRevoke(context: WorkerContext): Promise<Response> {
	const namespaces = grantNamespaces(context);
	if (!namespaces) return notConfigured(context);
	const bearer = await readBearer(context, namespaces.grants);
	if (bearer instanceof Response) return bearer;
	const revoked = await callGrants(bearer.stub, DownloadGrantPath.REVOKE, {
		id: bearer.parsed.grantId,
		secretHash: bearer.secretHash,
	});
	if (!revoked.ok) return relayGrantFailure(revoked);
	const grant = (await revoked.json()) as DownloadGrantInfo;
	if (grant.storagePrefix === getRequestState(context).storagePrefix) {
		addRouteResult(context, { revokedGrant: { publicId: bearer.publicId, grant, by: "bearer" } });
	}
	return new Response(null, { status: 204 });
}

export const grantBearer = new Hono<WorkerApp>()
	.get("/file", handleHead)
	.post("/links", handleIssueLink)
	.delete("/file", handleDeleteFile)
	.delete("/", handleRevoke);
