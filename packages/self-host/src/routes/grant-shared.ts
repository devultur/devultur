// What the owner's grant routes (`/v1/token/grant`) and the bearer's (`/v1/grant`) share: the file's `DownloadGrants`
// instance, the calls to it, and a grant as the API returns it.
import type { DownloadGrantListEntry } from "@devultur/core";
import type { Context } from "hono";
import type { DownloadGrantInfo, DownloadGrantPath } from "../download-grants";
import { formatGrantPublicId } from "../grant-credential";
import type { WorkerApp } from "../types";

export type WorkerContext = Context<WorkerApp>;

export interface GrantNamespaces {
	grants: DurableObjectNamespace;
	links: DurableObjectNamespace;
}

/** Both namespaces a grant needs, or null when the Worker lacks either binding. */
export function grantNamespaces(context: WorkerContext): GrantNamespaces | null {
	const { DOWNLOAD_GRANTS: grants, DOWNLOAD_LINKS: links } = context.env;
	return grants && links ? { grants, links } : null;
}

export function notConfigured(context: WorkerContext): Response {
	return context.json({ error: "Download grants are not configured", code: "not_configured" }, 501);
}

/** The `DownloadGrants` instance of a file and its id (what a grant's secret and public id carry). */
export function fileGrantsObject(namespace: DurableObjectNamespace, storageKey: string) {
	const id = namespace.idFromName(storageKey);
	return { objectId: id.toString(), stub: namespace.get(id) };
}

/** The `DownloadGrants` instance named in a grant's secret or public id. Null if the id isn't valid. */
export function grantsObjectById(namespace: DurableObjectNamespace, objectId: string): DurableObjectStub | null {
	try {
		return namespace.get(namespace.idFromString(objectId));
	} catch {
		return null;
	}
}

type GrantPathValue = (typeof DownloadGrantPath)[keyof typeof DownloadGrantPath];

export function callGrants(stub: DurableObjectStub, path: GrantPathValue, body: unknown = {}): Promise<Response> {
	return stub.fetch(`https://download-grants${path}`, { method: "POST", body: JSON.stringify(body) });
}

/** A failure of the `DownloadGrants` object, relayed as is. */
export const relayGrantFailure = (response: Response) =>
	new Response(response.body, { status: response.status, headers: response.headers });

/** A grant as listed to the owner: no secret, its public id. Pure. */
export function grantListEntry(objectId: string, grant: DownloadGrantInfo): DownloadGrantListEntry {
	return {
		id: formatGrantPublicId({ objectId, grantId: grant.id }),
		key: grant.key,
		expiresAt: grant.expiresAt,
		link: grant.link,
		maxLinks: grant.maxLinks,
		canDelete: grant.canDelete,
		...(grant.metadata ? { metadata: grant.metadata } : {}),
		linksIssued: grant.linksIssued,
		createdAt: grant.createdAt,
		revokedAt: grant.revokedAt,
	};
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Opaque metadata: string → string, at most `maxBytes` as JSON. `undefined` when absent, `null` when invalid. Pure.
 */
export function parseMetadata(value: unknown, maxBytes: number): Record<string, string> | undefined | null {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) return null;
	if (!Object.values(value).every((entry) => typeof entry === "string")) return null;
	const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
	return size <= maxBytes ? (value as Record<string, string>) : null;
}

/** A positive safe integer up to `max`, the default when absent, or null when invalid. Pure. */
export function parseCount(value: unknown, fallback: number, max: number): number | null {
	const count = value ?? fallback;
	return typeof count === "number" && Number.isSafeInteger(count) && count > 0 && count <= max ? count : null;
}
