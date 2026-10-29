// Where a media event goes: the scope's `config.webhooks`, else the `MEDIA_WEBHOOK_*` vars. The URL must be `https`
// on a public host, so a webhook can't be pointed at the Worker's own network (SSRF); `allowUnsafeUrl` lifts that for
// local development. A hostname is judged as written: the Workers runtime has no DNS lookup to check where it resolves.
import type { WebhookEventType } from "@devultur/core";
import type { WebhookConfig, WorkerConfig } from "../request-state";
import type { WorkerEnv } from "../types";

/** A resolved destination: one or more secrets, the event types it takes. */
export interface WebhookTarget {
	url: string;
	secrets: string[];
	events: WebhookEventType[];
	allowUnsafeUrl: boolean;
}

export const DEFAULT_WEBHOOK_EVENTS: WebhookEventType[] = ["media.deleted", "media.changed"];

type WebhookEnv = Pick<
	WorkerEnv,
	"MEDIA_WEBHOOK_URL" | "MEDIA_WEBHOOK_SECRET" | "MEDIA_WEBHOOK_EVENTS" | "MEDIA_WEBHOOK_ALLOW_UNSAFE_URL"
>;

const splitList = (value: string, separator: RegExp) =>
	value
		.split(separator)
		.map((entry) => entry.trim())
		.filter(Boolean);

function fromEnv(env: WebhookEnv): WebhookConfig | null {
	if (!env.MEDIA_WEBHOOK_URL || !env.MEDIA_WEBHOOK_SECRET) return null;
	return {
		url: env.MEDIA_WEBHOOK_URL,
		secret: splitList(env.MEDIA_WEBHOOK_SECRET, /\s+/),
		...(env.MEDIA_WEBHOOK_EVENTS ? { events: splitList(env.MEDIA_WEBHOOK_EVENTS, /,/) as WebhookEventType[] } : {}),
		allowUnsafeUrl: env.MEDIA_WEBHOOK_ALLOW_UNSAFE_URL === "true",
	};
}

/** The target of a webhook config, or null when it has no URL or secret. */
export function toWebhookTarget(config: WebhookConfig | null | undefined): WebhookTarget | null {
	if (!config?.url) return null;
	const secrets = (typeof config.secret === "string" ? [config.secret] : (config.secret ?? [])).filter(Boolean);
	if (secrets.length === 0) return null;
	return {
		url: config.url,
		secrets,
		events: config.events ?? DEFAULT_WEBHOOK_EVENTS,
		allowUnsafeUrl: config.allowUnsafeUrl === true,
	};
}

/** The scope's webhook (`config.webhooks`), else the Worker's (`MEDIA_WEBHOOK_URL` / `MEDIA_WEBHOOK_SECRET`). */
export function resolveWebhookTarget(config: WorkerConfig | undefined, env: WebhookEnv): WebhookTarget | null {
	return toWebhookTarget(config?.webhooks ?? fromEnv(env));
}

const isIpv4 = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

function isPrivateIpv4(host: string): boolean {
	const [a, b] = host.split(".").map(Number);
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

function isPrivateIpv6(host: string): boolean {
	const address = host.toLowerCase();
	if (address === "::" || address === "::1") return true;
	// IPv4-mapped (`::ffff:10.0.0.1`, which URL normalizes to `::ffff:a00:1`): judged as the IPv4 it maps.
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
	if (mapped) {
		const [high, low] = [Number.parseInt(mapped[1], 16), Number.parseInt(mapped[2], 16)];
		return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff].join("."));
	}
	if (/^::ffff:\d/.test(address)) return isPrivateIpv4(address.slice(7));
	// Unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8).
	return /^f[cd]/.test(address) || /^fe[89ab]/.test(address) || address.startsWith("ff");
}

function isPrivateHost(hostname: string): boolean {
	const host = hostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "")
		.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
		return true;
	}
	if (isIpv4(host)) return isPrivateIpv4(host);
	if (host.includes(":")) return isPrivateIpv6(host);
	// A single label (`intranet`) only resolves on a private network.
	return !host.includes(".");
}

/** Why `url` can't take webhooks, or null when it can. */
export function unsafeUrlReason(url: string, allowUnsafeUrl = false): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "not a valid URL";
	}
	if (parsed.username || parsed.password) return "credentials in the URL";
	if (allowUnsafeUrl) return parsed.protocol === "https:" || parsed.protocol === "http:" ? null : "not http(s)";
	if (parsed.protocol !== "https:") return "not https";
	if (isPrivateHost(parsed.hostname)) return "a private or loopback host";
	return null;
}
