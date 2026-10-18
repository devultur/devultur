// Cloudflare Images (`fetch` + `cf.image`): the Worker path's fallback and the mezzanine generator.
//
// Cloudflare re-requests the original from THIS Worker (`Via: image-resizing`) and counts every unique transform,
// identified by the origin URL. That's why the origin URL is the original's path WITHOUT query: with the viewer's
// `?token=`, every new token was one more "unique" transform (no cache shared between viewers). The
// authorization travels in `Authorization` (one of the headers Cloudflare passes to the origin with
// `origin-auth: share-publicly`): a deterministic credential per original, the same for all viewers, that
// carries the parent request's storage prefix (without the viewer's token, the worker would have no way to get it).
import { base64UrlDecode } from "../helpers";
import type { ImageTransformParams } from "./params";
import { type OutputFormat, resolveOutputFormat, resolveRequestedFormat } from "./transform-plan";

const IMAGE_RESIZING_VIA = "image-resizing";
const ORIGIN_MESSAGE_PREFIX = "image-origin:";
const ORIGIN_CREDENTIAL_PREFIX = "Bearer dvo.";

// `fill` (stretch) doesn't exist in Cloudflare; its equivalent is `squeeze`. The rest pass through unchanged.
const CLOUDFLARE_FIT: Record<string, BasicImageTransformations["fit"]> = {
	fill: "squeeze",
	cover: "cover",
	contain: "contain",
	"scale-down": "scale-down",
	pad: "pad",
};

/** The original that Cloudflare re-requests: its URL (without query) and the storage prefix it belongs to. */
export interface ImageOrigin {
	url: URL;
	scope: string;
}

/** URL that Cloudflare Images re-requests from the Worker: the original's path, without query (no token, no params). */
export function imageOriginUrl(requestUrl: URL): URL {
	return new URL(`${requestUrl.origin}${requestUrl.pathname}`);
}

async function originSigningKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
	const keyBytes = new TextEncoder().encode(secret);
	return crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

const originMessage = (scope: string, url: URL) =>
	new TextEncoder().encode(`${ORIGIN_MESSAGE_PREFIX}${scope}\n${url.host}${url.pathname}`);

const base64Url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

/** `Authorization` for Cloudflare's subrequest: `Bearer dvo.<scope>.<signature of scope + URL>`. */
export async function imageOriginAuthorization(secret: string, origin: ImageOrigin): Promise<string> {
	const key = await originSigningKey(secret, "sign");
	const signature = await crypto.subtle.sign("HMAC", key, originMessage(origin.scope, origin.url));
	const encodedScope = base64Url(new TextEncoder().encode(origin.scope));
	return `${ORIGIN_CREDENTIAL_PREFIX}${encodedScope}.${base64Url(new Uint8Array(signature))}`;
}

/**
 * If the request is Cloudflare Images' subrequest asking for an original, the signed storage prefix; otherwise null.
 * `Via` alone is NOT enough (a client can send it): it has to carry the signature for THIS URL.
 */
export async function readImageOriginScope(request: Request, secret: string | undefined): Promise<string | null> {
	if (request.method !== "GET" || !request.headers.get("via")?.includes(IMAGE_RESIZING_VIA)) return null;
	const authorization = request.headers.get("Authorization");
	if (!secret || !authorization?.startsWith(ORIGIN_CREDENTIAL_PREFIX)) return null;
	const [encodedScope, encodedSignature] = authorization.slice(ORIGIN_CREDENTIAL_PREFIX.length).split(".");
	if (encodedScope === undefined || !encodedSignature) return null;
	try {
		const scope = new TextDecoder().decode(base64UrlDecode(encodedScope));
		const key = await originSigningKey(secret, "verify");
		const message = originMessage(scope, new URL(request.url));
		const isValid = await crypto.subtle.verify("HMAC", key, base64UrlDecode(encodedSignature), message);
		return isValid ? scope : null;
	} catch {
		return null;
	}
}

/** Is this Cloudflare Images' signed subrequest? It's not delivery to the client: it isn't gated or counted. */
export async function isImageOriginRequest(request: Request, secret: string | undefined): Promise<boolean> {
	return (await readImageOriginScope(request, secret)) !== null;
}

/** `cf.image` options for a requested transform. The format arrives already negotiated (never `auto`). */
export function cloudflareImageOptions(
	params: ImageTransformParams,
	format: OutputFormat | null,
): RequestInitCfPropertiesImage {
	const options: RequestInitCfPropertiesImage = { "origin-auth": "share-publicly" };
	if (params.width) options.width = params.width;
	if (params.height) options.height = params.height;
	if (params.fit) options.fit = CLOUDFLARE_FIT[params.fit];
	if (params.quality) options.quality = params.quality;
	if (format) options.format = format;
	return options;
}

/** Asks Cloudflare Images for the original transformed with `image`. */
export async function fetchCloudflareImage(
	origin: ImageOrigin,
	secret: string,
	image: RequestInitCfPropertiesImage,
): Promise<Response> {
	return fetch(origin.url.toString(), {
		headers: { Authorization: await imageOriginAuthorization(secret, origin) },
		cf: { image },
	});
}

/**
 * Format for Cloudflare, negotiated by us (inside a Worker, `format: "auto"` doesn't look at `Accept`). Same
 * rule as the Worker path, except for AVIF: Cloudflare doesn't animate AVIF, so under `auto` only a JPEG
 * (never animated) goes to AVIF; the rest falls back to WebP. Null = no `?format` → Cloudflare keeps the original's format.
 */
export function cloudflareOutputFormat(
	params: ImageTransformParams,
	accept: string | undefined,
	sourceType: string,
): OutputFormat | null {
	const requested = resolveRequestedFormat(params, accept);
	if (requested === "source") return null;
	if (params.format !== "auto") return resolveOutputFormat(requested, sourceType);
	if (requested === "avif" && sourceType === "image/jpeg") return "avif";
	if (accept?.includes("image/webp")) return "webp";
	// Without webp: a GIF stays a GIF (still animated); the rest falls to baseline (PNG if it has alpha, else JPEG).
	if (sourceType === "image/gif") return null;
	return resolveOutputFormat("baseline", sourceType);
}

export interface CloudflareTransform {
	origin: ImageOrigin;
	secret: string;
	params: ImageTransformParams;
	accept: string | undefined;
	sourceType: string;
	cacheControl: string;
	disposition: string | undefined;
}

/** Fallback: Cloudflare Images does the whole transform; we only adjust the headers. */
export async function serveCloudflareTransform(transform: CloudflareTransform): Promise<Response> {
	const { params, accept, sourceType } = transform;
	const format = cloudflareOutputFormat(params, accept, sourceType);
	const image = cloudflareImageOptions(params, format);
	const transformed = await fetchCloudflareImage(transform.origin, transform.secret, image);

	const headers = new Headers(transformed.headers);
	headers.set("Cache-Control", transform.cacheControl);
	if (params.format === "auto") headers.set("Vary", "Accept");
	if (transform.disposition) headers.set("Content-Disposition", transform.disposition);
	return new Response(transformed.body, { status: transformed.status, headers });
}
