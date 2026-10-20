// Single-use download links. `POST /v1/token/download` (credential with `media:read`) creates state in the DO
// `DownloadLink` and returns `/v1/download/{id}`: the id is opaque (128 bits) and is NOT the credential. `GET /v1/download/{id}`
// carries no credential: it consumes a use in the DO and streams the file in THAT same response (with `Range`). A "use" =
// a redemption = a request: with `maxUses: 1` a download manager can't resume (it requests another link or uses
// `maxUses` > 1). There's no redirect to a signed URL: nothing reusable leaves the worker. With the `beforeLinkRedeem`
// hook (e.g. a delivery limit), the link is read without consuming it and the hook decides before redeeming.
import { contentDispositionAttachment, relativeMediaPath, TokenScope } from "@devultur/core";
import { type Context, Hono } from "hono";
import { DownloadLinkPath, type DownloadLinkRecord, recordContext } from "../download-link";
import { contentDispositionInline, storageKey } from "../helpers";
import { isExpiredAndUnlocked } from "../object-lock/delivery";
import { cappedExpiry, decideCredential, gateLinkRedemption, getPluginHooks } from "../plugin-hooks";
import { getRequestState } from "../request-state";
import { addRouteResult, type DownloadLinkInfo } from "../route-result";
import type { WorkerApp } from "../types";
import { expiredResponse, streamObject } from "./object-response";

const DEFAULT_LINK_TTL_SECONDS = 15 * 60;
export const MAX_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MAX_LINK_USES = 100;
const LINK_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

type WorkerContext = Context<WorkerApp>;

interface DownloadLinkRequest {
	key?: unknown;
	expiresIn?: unknown;
	maxUses?: unknown;
	filename?: unknown;
}

function newLinkId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function linkStub(namespace: DurableObjectNamespace, linkId: string) {
	return namespace.get(namespace.idFromName(linkId));
}

const isIntegerIn = (value: unknown, max: number): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;

function parseLinkRequest(body: DownloadLinkRequest) {
	const key = typeof body.key === "string" ? body.key : "";
	if (relativeMediaPath(key) === null) {
		return { error: "key must be a visibility-prefixed media key", code: "invalid_key" };
	}
	const expiresIn = body.expiresIn ?? DEFAULT_LINK_TTL_SECONDS;
	if (!isIntegerIn(expiresIn, MAX_LINK_TTL_SECONDS)) {
		return { error: `expiresIn must be 1..${MAX_LINK_TTL_SECONDS} seconds`, code: "invalid_expires_in" };
	}
	const maxUses = body.maxUses ?? 1;
	if (!isIntegerIn(maxUses, MAX_LINK_USES)) {
		return { error: `maxUses must be 1..${MAX_LINK_USES}`, code: "invalid_max_uses" };
	}
	const filename = typeof body.filename === "string" && body.filename ? body.filename : undefined;
	return { key, expiresIn, maxUses, filename };
}

/** `POST /v1/token/download` `{ key, expiresIn?, maxUses?, filename? }` → `{ url, expiresAt, maxUses }`. */
export async function handleDownloadLink(context: WorkerContext): Promise<Response> {
	const namespace = context.env.DOWNLOAD_LINKS;
	if (!namespace) return context.json({ error: "Download links are not configured", code: "not_configured" }, 501);
	const parsed = parseLinkRequest(((await context.req.json().catch(() => null)) ?? {}) as DownloadLinkRequest);
	if ("error" in parsed) return context.json(parsed, 400);

	const fullKey = storageKey(context, parsed.key);
	const object = await context.env.MEDIA_BUCKET.head(fullKey);
	if (!object) return context.json({ error: "Not found" }, 404);
	const location = { root: getRequestState(context).storagePrefix, key: parsed.key };
	if (await isExpiredAndUnlocked(context.env.MEDIA_BUCKET, location, object)) return expiredResponse();

	// The link doesn't outlive the file, nor whatever the `issueCredential` hook allows.
	const objectExpiresAt = Number(object.customMetadata?.expiresAt) || Infinity;
	const requestedExpiresAt = Math.min(Date.now() + parsed.expiresIn * 1000, objectExpiresAt);
	const decision = await decideCredential(context, {
		kind: "download-link",
		scopes: [TokenScope.MEDIA_READ],
		path: parsed.key,
		expiresAt: requestedExpiresAt,
	});
	if (!decision.allow) return decision.response;
	const expiresAt = cappedExpiry(requestedExpiresAt, decision.expiresAt, (epochMs) => epochMs);
	const linkId = newLinkId();
	const scope = getRequestState(context);
	const record: Omit<DownloadLinkRecord, "uses"> = {
		storageKey: fullKey,
		key: parsed.key,
		expiresAt,
		maxUses: parsed.maxUses,
		...(parsed.filename ? { filename: parsed.filename } : {}),
		storagePrefix: scope.storagePrefix,
		...(scope.context ? { context: scope.context } : {}),
	};
	const created = await linkStub(namespace, linkId).fetch(`https://download-link${DownloadLinkPath.CREATE}`, {
		method: "POST",
		body: JSON.stringify(record),
	});
	if (!created.ok) return context.json({ error: "Could not create the download link" }, 500);
	const origin = new URL(context.req.url).origin;
	return context.json({ url: `${origin}/v1/download/${linkId}`, expiresAt, maxUses: parsed.maxUses });
}

function attachmentDisposition(record: DownloadLinkRecord, storedDisposition: string | undefined): string {
	if (record.filename) return contentDispositionAttachment(record.filename);
	const fallback = storedDisposition ?? contentDispositionInline(record.key.split("/").pop() || "download");
	return fallback.startsWith("inline") ? `attachment${fallback.slice("inline".length)}` : fallback;
}

const callLink = (stub: DurableObjectStub, path: string) =>
	stub.fetch(`https://download-link${path}`, { method: "POST" });

const relayLinkFailure = (response: Response) =>
	new Response(response.body, { status: response.status, headers: response.headers });

function linkInfoOf(record: DownloadLinkRecord): DownloadLinkInfo {
	const context = recordContext(record);
	return { storagePrefix: record.storagePrefix, key: record.key, ...(context ? { context } : {}) };
}

/** With `beforeLinkRedeem` hooks, asks them BEFORE redeeming: a refusal doesn't spend the use. Without, nothing to ask. */
async function gateRedemption(context: WorkerContext, stub: DurableObjectStub): Promise<Response | null> {
	if (getPluginHooks(context).beforeLinkRedeem.length === 0) return null;
	const peeked = await callLink(stub, DownloadLinkPath.PEEK);
	if (!peeked.ok) return relayLinkFailure(peeked);
	return gateLinkRedemption(context, linkInfoOf((await peeked.json()) as DownloadLinkRecord));
}

const download = new Hono<WorkerApp>();

download.get("/:linkId", async (context) => {
	// Hono enruta HEAD al GET: un HEAD (previsualizador de links) no debe gastar el uso.
	if (context.req.method === "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET" } });
	const linkId = context.req.param("linkId");
	const namespace = context.env.DOWNLOAD_LINKS;
	if (!namespace || !LINK_ID_PATTERN.test(linkId)) return context.json({ error: "Not found" }, 404);

	const stub = linkStub(namespace, linkId);
	const blocked = await gateRedemption(context, stub);
	if (blocked) return blocked;
	const redeemed = await callLink(stub, DownloadLinkPath.REDEEM);
	if (!redeemed.ok) return relayLinkFailure(redeemed);
	const record = (await redeemed.json()) as DownloadLinkRecord;

	const object = await context.env.MEDIA_BUCKET.get(record.storageKey);
	if (!object) return context.json({ error: "Not found" }, 404);
	const location = { root: record.storagePrefix, key: record.key };
	if (await isExpiredAndUnlocked(context.env.MEDIA_BUCKET, location, object)) return expiredResponse();
	addRouteResult(context, { redeemedLink: linkInfoOf(record) });

	const headers = new Headers({
		"Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
		"Cache-Control": "private, no-store",
		"Content-Disposition": attachmentDisposition(record, object.httpMetadata?.contentDisposition),
	});
	const { response } = await streamObject({
		bucket: context.env.MEDIA_BUCKET,
		keysBucket: context.env.KEYS_BUCKET,
		fullKey: record.storageKey,
		object,
		headers,
		range: context.req.header("Range"),
	});
	return response;
});

export { download };
