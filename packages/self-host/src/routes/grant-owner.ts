// The owner's side of download grants, with the Worker's credential (`/v1/token/grant`):
// - `POST`   `{ key, expiresIn?, link?, maxLinks?, canDelete?, metadata? }` → the grant, its secret shown once.
// - `GET`    `?key=` → the file's grants (no secrets).
// - `DELETE` `/{publicId}` → revokes one. 204, idempotent.
// A grant is a credential like a download link: `issueCredential` hooks decide it (kind `download-grant`, `media:read`
// plus `media:delete` when it may delete) and may shorten it. It never outlives its file.
import { type DownloadGrant, DownloadGrantLimits, relativeMediaPath, TokenScope } from "@devultur/core";
import { Hono } from "hono";
import { type DownloadGrantInfo, DownloadGrantPath, type DownloadGrantRecord } from "../download-grants";
import {
	formatGrantPublicId,
	formatGrantSecret,
	hashGrantSecret,
	newGrantId,
	newGrantSecret,
	parseGrantPublicId,
} from "../grant-credential";
import { storageKey } from "../helpers";
import { cappedExpiry, decideCredential, gateGrantAccess } from "../plugin-hooks";
import { getRequestState } from "../request-state";
import { addRouteResult } from "../route-result";
import type { WorkerApp } from "../types";
import {
	callGrants,
	fileGrantsObject,
	grantListEntry,
	grantNamespaces,
	grantsObjectById,
	notConfigured,
	parseCount,
	parseMetadata,
	type WorkerContext,
} from "./grant-shared";
import { expiredResponse, isObjectExpired, objectExpiresAt } from "./object-response";

/** Scope a grant that may delete its file needs on top of `media:read`. */
export const GRANT_DELETE_SCOPE = "media:delete";

interface GrantRequestBody {
	key?: unknown;
	expiresIn?: unknown;
	link?: { maxExpiresIn?: unknown; maxUses?: unknown };
	maxLinks?: unknown;
	canDelete?: unknown;
	metadata?: unknown;
}

interface ParsedGrantRequest {
	key: string;
	expiresIn?: number;
	link: { maxExpiresIn: number; maxUses: number };
	maxLinks: number;
	canDelete: boolean;
	metadata?: Record<string, string>;
}

type ParseFailure = { error: string; code: string };

const invalid = (code: string, error: string): ParseFailure => ({ error, code });

function parseLinkCaps(link: GrantRequestBody["link"]): ParsedGrantRequest["link"] | ParseFailure {
	const maxExpiresIn = parseCount(
		link?.maxExpiresIn,
		DownloadGrantLimits.DEFAULT_LINK_EXPIRES_IN,
		DownloadGrantLimits.MAX_LINK_EXPIRES_IN,
	);
	if (maxExpiresIn === null) {
		return invalid("invalid_link_caps", `link.maxExpiresIn must be 1..${DownloadGrantLimits.MAX_LINK_EXPIRES_IN}`);
	}
	const maxUses = parseCount(
		link?.maxUses,
		DownloadGrantLimits.DEFAULT_LINK_MAX_USES,
		DownloadGrantLimits.MAX_LINK_MAX_USES,
	);
	if (maxUses === null) {
		return invalid("invalid_link_caps", `link.maxUses must be 1..${DownloadGrantLimits.MAX_LINK_MAX_USES}`);
	}
	return { maxExpiresIn, maxUses };
}

/** The request, or why it's invalid. Pure. */
export function parseGrantRequest(body: GrantRequestBody): ParsedGrantRequest | ParseFailure {
	const key = typeof body.key === "string" ? body.key : "";
	if (relativeMediaPath(key) === null) return invalid("invalid_key", "key must be a visibility-prefixed media key");
	const expiresIn = body.expiresIn === undefined ? undefined : parseCount(body.expiresIn, 0, Number.MAX_SAFE_INTEGER);
	if (expiresIn === null) return invalid("invalid_expires_in", "expiresIn must be a positive number of seconds");
	if (body.link !== undefined && (typeof body.link !== "object" || body.link === null)) {
		return invalid("invalid_link_caps", "link must be an object");
	}
	const link = parseLinkCaps(body.link);
	if ("error" in link) return link;
	const maxLinks = parseCount(body.maxLinks, DownloadGrantLimits.DEFAULT_MAX_LINKS, DownloadGrantLimits.MAX_MAX_LINKS);
	if (maxLinks === null)
		return invalid("invalid_max_links", `maxLinks must be 1..${DownloadGrantLimits.MAX_MAX_LINKS}`);
	if (body.canDelete !== undefined && typeof body.canDelete !== "boolean") {
		return invalid("invalid_can_delete", "canDelete must be a boolean");
	}
	const metadata = parseMetadata(body.metadata, DownloadGrantLimits.MAX_METADATA_BYTES);
	if (metadata === null) {
		return invalid(
			"invalid_metadata",
			`metadata must map strings to strings, ${DownloadGrantLimits.MAX_METADATA_BYTES} bytes at most`,
		);
	}
	return {
		key,
		...(expiresIn ? { expiresIn } : {}),
		link,
		maxLinks,
		canDelete: body.canDelete === true,
		...(metadata ? { metadata } : {}),
	};
}

/** Requested grant expiry (epoch ms): never past the file's, and at most 30 days for a file without one. Pure. */
export function grantExpiry(expiresIn: number | undefined, fileExpiresAt: number | undefined, now: number): number {
	const cap = fileExpiresAt ?? now + DownloadGrantLimits.MAX_LIFETIME_SECONDS * 1000;
	return expiresIn === undefined ? cap : Math.min(now + expiresIn * 1000, cap);
}

async function handleCreateGrant(context: WorkerContext): Promise<Response> {
	const namespaces = grantNamespaces(context);
	if (!namespaces) return notConfigured(context);
	const parsed = parseGrantRequest(((await context.req.json().catch(() => null)) ?? {}) as GrantRequestBody);
	if ("error" in parsed) return context.json(parsed, 400);

	const fullKey = storageKey(context, parsed.key);
	const object = await context.env.MEDIA_BUCKET.head(fullKey);
	if (!object) return context.json({ error: "Not found" }, 404);
	if (isObjectExpired(object.customMetadata)) return expiredResponse();

	const requestedExpiresAt = grantExpiry(parsed.expiresIn, objectExpiresAt(object.customMetadata), Date.now());
	const decision = await decideCredential(context, {
		kind: "download-grant",
		scopes: parsed.canDelete ? [TokenScope.MEDIA_READ, GRANT_DELETE_SCOPE] : [TokenScope.MEDIA_READ],
		path: parsed.key,
		expiresAt: requestedExpiresAt,
	});
	if (!decision.allow) return decision.response;

	const { objectId, stub } = fileGrantsObject(namespaces.grants, fullKey);
	const grantId = newGrantId();
	const secret = newGrantSecret();
	const scope = getRequestState(context);
	const record: Omit<DownloadGrantRecord, "linksIssued" | "revokedAt"> = {
		id: grantId,
		secretHash: await hashGrantSecret(secret),
		storageKey: fullKey,
		key: parsed.key,
		version: object.version,
		storagePrefix: scope.storagePrefix,
		expiresAt: cappedExpiry(requestedExpiresAt, decision.expiresAt, (epochMs) => epochMs),
		link: parsed.link,
		maxLinks: parsed.maxLinks,
		canDelete: parsed.canDelete,
		...(parsed.metadata ? { metadata: parsed.metadata } : {}),
		...(scope.context ? { context: scope.context } : {}),
		createdAt: Date.now(),
	};
	const created = await callGrants(stub, DownloadGrantPath.CREATE, record);
	if (!created.ok) return context.json({ error: "Could not create the download grant" }, 500);

	const publicId = formatGrantPublicId({ objectId, grantId });
	const { secretHash: _secretHash, ...info } = record;
	addRouteResult(context, { issuedGrant: { publicId, grant: { ...info, linksIssued: 0, revokedAt: null } } });
	const grant: DownloadGrant = {
		grant: formatGrantSecret({ objectId, grantId, secret }),
		id: publicId,
		key: record.key,
		expiresAt: record.expiresAt,
		link: record.link,
		maxLinks: record.maxLinks,
		canDelete: record.canDelete,
		...(record.metadata ? { metadata: record.metadata } : {}),
	};
	return context.json(grant);
}

async function handleListGrants(context: WorkerContext): Promise<Response> {
	const namespaces = grantNamespaces(context);
	if (!namespaces) return notConfigured(context);
	const key = context.req.query("key") ?? "";
	if (relativeMediaPath(key) === null) {
		return context.json({ error: "key must be a visibility-prefixed media key", code: "invalid_key" }, 400);
	}
	const { objectId, stub } = fileGrantsObject(namespaces.grants, storageKey(context, key));
	const listed = await callGrants(stub, DownloadGrantPath.LIST);
	if (!listed.ok) return context.json({ error: "Could not list the download grants" }, 500);
	const grants = (await listed.json()) as DownloadGrantInfo[];
	return context.json(grants.map((grant) => grantListEntry(objectId, grant)));
}

const grantNotFound = (context: WorkerContext) =>
	context.json({ error: "Download grant not found", code: "grant_not_found" }, 404);

async function handleRevokeGrant(context: WorkerContext): Promise<Response> {
	const namespaces = grantNamespaces(context);
	if (!namespaces) return notConfigured(context);
	const publicId = context.req.param("id") ?? "";
	const location = parseGrantPublicId(publicId);
	const stub = location ? grantsObjectById(namespaces.grants, location.objectId) : null;
	if (!location || !stub) return grantNotFound(context);

	const found = await callGrants(stub, DownloadGrantPath.GET, { id: location.grantId });
	if (!found.ok) return grantNotFound(context);
	const grant = (await found.json()) as DownloadGrantInfo;
	// Another tenant's grant doesn't exist for this one.
	if (grant.storagePrefix !== getRequestState(context).storagePrefix) return grantNotFound(context);
	const refusal = await gateGrantAccess(context, { action: "owner-revoke", grant });
	if (refusal) return refusal;

	const revoked = await callGrants(stub, DownloadGrantPath.REVOKE, { id: location.grantId });
	if (!revoked.ok) return context.json({ error: "Could not revoke the download grant" }, 500);
	addRouteResult(context, {
		revokedGrant: { publicId, grant: (await revoked.json()) as DownloadGrantInfo, by: "owner" },
	});
	return new Response(null, { status: 204 });
}

export const grantOwner = new Hono<WorkerApp>()
	.post("/", handleCreateGrant)
	.get("/", handleListGrants)
	.delete("/:id", handleRevokeGrant);
