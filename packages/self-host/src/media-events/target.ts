// Where a media event goes: the scope's `config.webhooks`, else the `MEDIA_WEBHOOK_*` vars. The URL must be `https`
// on a public host, so a webhook can't be pointed at the Worker's own network (SSRF); `allowUnsafeUrl` lifts that for
// local development.
//
// The check is on the URL as written, with no DNS resolution (the Workers runtime has no lookup): a hostname that
// resolves to a private address is the operator's to refuse. Only hostnames that spell a dotted IPv4 (wildcard DNS
// names like `10.0.0.1.nip.io`) are refused here.
import type { WebhookEventType } from "@devultur/core";
import type { WebhookConfig, WorkerConfig } from "../request-state";
import type { WorkerEnv } from "../types";

/**
 * Scope of the `MEDIA_WEBHOOK_*` vars, and the default scope of a `config.webhooks` without one. A queued event and a
 * transcode job keep only their target's scope: its URL and secrets are resolved again when it's delivered, so a
 * rotated or revoked secret takes effect for what's already queued, and no secret is ever stored.
 */
export const ENV_WEBHOOK_SCOPE = "env";
export const CONFIG_WEBHOOK_SCOPE = "config";

/** A resolved destination: its scope, one or more secrets, the event types it takes. */
export interface WebhookTarget {
	scope: string;
	url: string;
	secrets: string[];
	events: WebhookEventType[];
	allowUnsafeUrl: boolean;
}

/** Resolves a scope to its webhook (a plugin's `resolveWebhookTarget`); null or undefined: not this plugin's. */
export type WebhookTargetResolver = (
	env: WorkerEnv,
	scope: string,
) => WebhookConfig | null | undefined | Promise<WebhookConfig | null | undefined>;

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
		scope: ENV_WEBHOOK_SCOPE,
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
		scope: config.scope ?? CONFIG_WEBHOOK_SCOPE,
		url: config.url,
		secrets,
		events: config.events ?? DEFAULT_WEBHOOK_EVENTS,
		allowUnsafeUrl: config.allowUnsafeUrl === true,
	};
}

/** The request's webhook: the scope's (`config.webhooks`), else the Worker's (`MEDIA_WEBHOOK_URL` / `_SECRET`). */
export function webhookTargetOf(config: WorkerConfig | undefined, env: WebhookEnv): WebhookTarget | null {
	return toWebhookTarget(config?.webhooks ?? fromEnv(env));
}

/**
 * The webhook of `scope`, resolved now: `env` from the vars, any other one from the first resolver that knows it
 * (`staticConfig` knows its `config.webhooks`; a plugin of yours, the scopes it sets). Null when none does.
 */
export async function webhookTargetOfScope(
	env: WorkerEnv,
	scope: string,
	resolvers: readonly WebhookTargetResolver[],
): Promise<WebhookTarget | null> {
	if (scope === ENV_WEBHOOK_SCOPE) return toWebhookTarget(fromEnv(env));
	for (const resolve of resolvers) {
		const config = await resolve(env, scope);
		if (config) return toWebhookTarget({ ...config, scope });
	}
	return null;
}

const isIpv4 = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
// A dotted IPv4 inside a hostname (`10.0.0.1.nip.io`): a wildcard DNS name that resolves to the address it spells.
const EMBEDS_IPV4 = /(^|\.)\d{1,3}(\.\d{1,3}){3}(\.|$)/;

/** Special-purpose IPv4 ranges (RFC 6890 and successors): none of them is a public webhook host. */
function isPrivateIpv4(host: string): boolean {
	const [a, b, c] = host.split(".").map(Number);
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0 && (c === 0 || c === 2)) ||
		(a === 192 && b === 88 && c === 99) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
}

/** The eight 16-bit groups of an IPv6 address as `URL` normalizes it (compressed, an IPv4 tail in hex), or null. */
function ipv6Groups(address: string): number[] | null {
	const halves = address.split("::");
	if (halves.length > 2) return null;
	const parse = (part: string) => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : []);
	const head = parse(halves[0] ?? "");
	const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
	const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail] : head;
	return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0) ? groups : null;
}

/**
 * Special-purpose IPv6 ranges: unspecified and loopback, IPv4-compatible (`::/96`) and IPv4-mapped (`::ffff:0:0/96`),
 * NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), discard (`100::/64`), the IETF protocol block (`2001::/23`: Teredo,
 * benchmarking, ORCHID), documentation (`2001:db8::/32`), 6to4 (`2002::/16`), unique local (`fc00::/7`), link- and
 * site-local (`fe80::/10`, `fec0::/10`) and multicast (`ff00::/8`). Any that embeds an IPv4 is refused outright: it
 * can reach a private IPv4 through a translator.
 */
function isPrivateIpv6(address: string): boolean {
	const groups = ipv6Groups(address.toLowerCase());
	if (!groups) return true;
	const [g0, g1, g2, g3, g4, g5] = groups;
	const startsWith = (...prefix: number[]) => prefix.every((group, index) => groups[index] === group);
	return (
		(g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) ||
		startsWith(0x64, 0xff9b, 0, 0, 0, 0) ||
		startsWith(0x64, 0xff9b, 1) ||
		startsWith(0x100, 0, 0, 0) ||
		(g0 === 0x2001 && g1 < 0x200) ||
		startsWith(0x2001, 0xdb8) ||
		g0 === 0x2002 ||
		(g0 & 0xfe00) === 0xfc00 ||
		(g0 & 0xffc0) === 0xfe80 ||
		(g0 & 0xffc0) === 0xfec0 ||
		(g0 & 0xff00) === 0xff00
	);
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
	if (EMBEDS_IPV4.test(host)) return true;
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
	if (isPrivateHost(parsed.hostname)) return "a private or special-purpose host";
	return null;
}
