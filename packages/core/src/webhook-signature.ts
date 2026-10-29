// Webhook signatures in the Standard Webhooks format (https://www.standardwebhooks.com): three headers, and an
// HMAC-SHA256 over `{id}.{timestamp}.{body}`. During a secret rotation the sender signs with every secret it holds
// (several space-separated `v1,<signature>` entries), so receivers on either secret accept it. Runtime-neutral: Web
// Crypto only, so it runs in Workers, Convex, Node and browsers alike.
import { timingSafeEqual } from "./bearer";

export const WEBHOOK_ID_HEADER = "webhook-id";
export const WEBHOOK_TIMESTAMP_HEADER = "webhook-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "webhook-signature";

/** How far, in seconds, a timestamp may be from the receiver's clock (either way). */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

const SECRET_PREFIX = "whsec_";
const SIGNATURE_VERSION = "v1";

/**
 * A signing secret: `whsec_<base64>` (the Standard Webhooks format, the key is the decoded bytes) or any other string
 * (the key is its UTF-8 bytes). Several: the sender signs with each one, a receiver accepts any of them.
 */
export type WebhookSecret = string | readonly string[];

export interface SignWebhookOptions {
	/** The event's id: the receiver deduplicates by it. */
	id: string;
	/** The exact body sent. */
	payload: string;
	secret: WebhookSecret;
	/** Unix seconds. Default: now. */
	timestamp?: number;
}

export type WebhookHeaders = Record<
	typeof WEBHOOK_ID_HEADER | typeof WEBHOOK_TIMESTAMP_HEADER | typeof WEBHOOK_SIGNATURE_HEADER,
	string
>;

export interface VerifyWebhookOptions {
	/** The raw body as received: parsing and serializing it again changes the bytes. */
	payload: string;
	headers: Headers | Record<string, string | null | undefined>;
	secret: WebhookSecret;
	/** Default {@link DEFAULT_WEBHOOK_TOLERANCE_SECONDS}. */
	toleranceSeconds?: number;
	/** Unix seconds. Default: now. */
	now?: number;
}

export type WebhookVerificationFailure =
	| "missing_headers"
	| "invalid_timestamp"
	| "timestamp_out_of_tolerance"
	| "no_matching_signature";

export type WebhookVerification =
	| { ok: true; id: string; timestamp: number }
	| { ok: false; reason: WebhookVerificationFailure };

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
	if (!secret.startsWith(SECRET_PREFIX)) return encoder.encode(secret);
	const binary = atob(secret.slice(SECRET_PREFIX.length));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const secretsOf = (secret: WebhookSecret): string[] =>
	(typeof secret === "string" ? [secret] : [...secret]).filter((value) => value.length > 0);

async function signatureOf(secret: string, content: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", secretBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	return toBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(content))));
}

const signedContent = (id: string, timestamp: number, payload: string) => `${id}.${timestamp}.${payload}`;

/** The three headers to send with `payload`. Throws without a secret: an unsigned webhook is never sent as signed. */
export async function signWebhook(options: SignWebhookOptions): Promise<WebhookHeaders> {
	const secrets = secretsOf(options.secret);
	if (secrets.length === 0) throw new Error("signWebhook: no secret");
	const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
	const content = signedContent(options.id, timestamp, options.payload);
	const signatures = await Promise.all(secrets.map((secret) => signatureOf(secret, content)));
	return {
		[WEBHOOK_ID_HEADER]: options.id,
		[WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
		[WEBHOOK_SIGNATURE_HEADER]: signatures.map((signature) => `${SIGNATURE_VERSION},${signature}`).join(" "),
	};
}

function headerOf(headers: VerifyWebhookOptions["headers"], name: string): string | undefined {
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
	return entry?.[1] ?? undefined;
}

/** The `v1` signatures of a `webhook-signature` header (other versions are ignored). */
function receivedSignatures(header: string): string[] {
	return header
		.split(" ")
		.map((entry) => entry.split(","))
		.filter(([version, signature]) => version === SIGNATURE_VERSION && signature)
		.map(([, signature]) => signature);
}

/**
 * Checks a received webhook: the timestamp is within the tolerance (a replayed request is refused) and at least one of
 * its signatures matches one of the secrets (compared in constant time). Fails closed without a secret.
 */
export async function verifyWebhookSignature(options: VerifyWebhookOptions): Promise<WebhookVerification> {
	const id = headerOf(options.headers, WEBHOOK_ID_HEADER);
	const timestampHeader = headerOf(options.headers, WEBHOOK_TIMESTAMP_HEADER);
	const signatureHeader = headerOf(options.headers, WEBHOOK_SIGNATURE_HEADER);
	if (!id || !timestampHeader || !signatureHeader) return { ok: false, reason: "missing_headers" };
	if (!/^\d+$/.test(timestampHeader)) return { ok: false, reason: "invalid_timestamp" };
	const timestamp = Number(timestampHeader);
	const now = options.now ?? Math.floor(Date.now() / 1000);
	const tolerance = options.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
	if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: "timestamp_out_of_tolerance" };

	const content = signedContent(id, timestamp, options.payload);
	const expected = await Promise.all(secretsOf(options.secret).map((secret) => signatureOf(secret, content)));
	const received = receivedSignatures(signatureHeader);
	// Every pair is compared, without stopping at the first match: the time doesn't tell which one matched.
	let isMatch = false;
	for (const signature of received) {
		for (const candidate of expected) isMatch = timingSafeEqual(signature, candidate) || isMatch;
	}
	return isMatch ? { ok: true, id, timestamp } : { ok: false, reason: "no_matching_signature" };
}
