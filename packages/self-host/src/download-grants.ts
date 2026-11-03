// Durable Object `DownloadGrants`: the download grants of ONE file (one instance per file, `idFromName(storageKey)`).
// A grant caps how many links its bearer may issue, so `linksIssued` needs an atomic counter; KV is eventually
// consistent. Every request runs inside `blockConcurrencyWhile`, so `check caps → linksIssued+1 → put` never
// interleaves with another issue. One instance per file (not per grant) lets the owner list a file's grants and revoke
// one by its public id without an index. Only the SHA-256 of each grant's secret is stored. An alarm at the earliest
// expiry drops expired grants. No `cloudflare:workers` import (a class with `fetch`): Node tests pass a fake storage.
import { DownloadGrantErrorCode, type DownloadGrantLinkCaps } from "@devultur/core";
import { isConstantTimeEqual } from "./bearer";
import type { PluginContext } from "./request-state";

export interface DownloadGrantRecord {
	/** Grant id, unique within its file. */
	id: string;
	/** SHA-256 (hex) of the grant's secret. */
	secretHash: string;
	/** Full storage key (with the storage prefix). */
	storageKey: string;
	/** Virtual key (`{visibility}/…`). */
	key: string;
	/** R2 `version` of the object the grant was issued for: a file uploaded later at the same key isn't covered. */
	version: string;
	/** Storage prefix the grant was issued under. */
	storagePrefix: string;
	/** Epoch ms. */
	expiresAt: number;
	link: DownloadGrantLinkCaps;
	maxLinks: number;
	linksIssued: number;
	canDelete: boolean;
	metadata?: Record<string, string>;
	/** Plugin context of the request that issued the grant (opaque to the Worker); its links inherit it. */
	context?: PluginContext;
	/** Epoch ms. */
	createdAt: number;
	/** Epoch ms, or null while live. */
	revokedAt: number | null;
}

/** A grant without its secret hash: what the Worker hands to routes, hooks and the owner. */
export type DownloadGrantInfo = Omit<DownloadGrantRecord, "secretHash">;

export const DownloadGrantPath = {
	/** Stores a new grant. Body: the record without `linksIssued`/`revokedAt`. */
	CREATE: "/create",
	/** The live grant for `{ id, secretHash }`. */
	AUTHORIZE: "/authorize",
	/** The grant for `{ id, secretHash }`, live or not: who it belongs to, before deciding anything. */
	IDENTIFY: "/identify",
	/** Spends one link of a live grant. Body: `{ id, secretHash, expiresIn, maxUses }`. */
	ISSUE: "/issue",
	/** Gives back a link spent by `ISSUE` whose creation failed. Body: `{ id }`. */
	REFUND: "/refund",
	/** Revokes `{ id }` (the owner) or `{ id, secretHash }` (the bearer). Idempotent. */
	REVOKE: "/revoke",
	/** One grant by `{ id }`, live or not, for the owner. */
	GET: "/get",
	/** Every grant of the file, for the owner. */
	LIST: "/list",
	/** Revokes every grant of the file: it's gone. They stay listed until they expire. */
	REVOKE_ALL: "/revoke-all",
} as const;

/** Storage surface of a DO that the class uses (the Workers one satisfies it; tests pass a Map). */
export interface DownloadGrantStorage {
	get<T>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
	list<T>(options: { prefix: string }): Promise<Map<string, T>>;
	delete(key: string): Promise<boolean>;
	setAlarm(scheduledTime: number): Promise<void>;
	deleteAlarm(): Promise<void>;
}

export interface DownloadGrantState {
	storage: DownloadGrantStorage;
	blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

interface GrantCredentialBody {
	id?: unknown;
	secretHash?: unknown;
}

interface IssueBody extends GrantCredentialBody {
	expiresIn?: unknown;
	maxUses?: unknown;
}

const GRANT_KEY_PREFIX = "grant:";
const grantKey = (id: string) => `${GRANT_KEY_PREFIX}${id}`;

const failure = (status: number, code: string, error: string) => Response.json({ error, code }, { status });
const invalidGrant = () => failure(401, DownloadGrantErrorCode.INVALID, "Invalid download grant");
const grantGone = () => failure(410, DownloadGrantErrorCode.GONE, "This download grant is no longer valid");
const notFound = () => failure(404, DownloadGrantErrorCode.NOT_FOUND, "Download grant not found");

/** The record without its secret hash. Pure. */
export function grantInfoOf(record: DownloadGrantRecord): DownloadGrantInfo {
	const { secretHash: _secretHash, ...info } = record;
	return info;
}

/** Is the grant past its expiry or revoked? Pure. */
export function isGrantDead(record: DownloadGrantRecord, now = Date.now()): boolean {
	return record.revokedAt !== null || record.expiresAt <= now;
}

/** Does a link of `expiresIn` seconds and `maxUses` fit the grant's caps? Pure. */
export function fitsLinkCaps(caps: DownloadGrantLinkCaps, expiresIn: number, maxUses: number): boolean {
	return expiresIn <= caps.maxExpiresIn && maxUses <= caps.maxUses;
}

export class DownloadGrants {
	private readonly state: DownloadGrantState;
	private readonly storage: DownloadGrantStorage;

	constructor(state: DownloadGrantState) {
		this.state = state;
		this.storage = state.storage;
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") return new Response(null, { status: 405 });
		const handler = this.handlerFor(new URL(request.url).pathname);
		if (!handler) return new Response(null, { status: 404 });
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		return this.state.blockConcurrencyWhile(() => handler(body));
	}

	private handlerFor(pathname: string): ((body: Record<string, unknown>) => Promise<Response>) | null {
		switch (pathname) {
			case DownloadGrantPath.CREATE:
				return (body) => this.create(body as unknown as DownloadGrantRecord);
			case DownloadGrantPath.AUTHORIZE:
				return (body) => this.authorize(body);
			case DownloadGrantPath.IDENTIFY:
				return (body) => this.identify(body);
			case DownloadGrantPath.ISSUE:
				return (body) => this.issue(body);
			case DownloadGrantPath.REFUND:
				return (body) => this.refund(body);
			case DownloadGrantPath.REVOKE:
				return (body) => this.revoke(body);
			case DownloadGrantPath.GET:
				return (body) => this.getOne(body);
			case DownloadGrantPath.LIST:
				return () => this.list();
			case DownloadGrantPath.REVOKE_ALL:
				return () => this.revokeAll();
			default:
				return null;
		}
	}

	private async create(record: DownloadGrantRecord): Promise<Response> {
		if (await this.storage.get(grantKey(record.id))) {
			return failure(409, "grant_exists", "Grant id already in use");
		}
		await this.storage.put(grantKey(record.id), { ...record, linksIssued: 0, revokedAt: null });
		await this.scheduleAlarm();
		return Response.json({ ok: true }, { status: 201 });
	}

	private async recordOf(id: unknown): Promise<DownloadGrantRecord | undefined> {
		return typeof id === "string" ? this.storage.get<DownloadGrantRecord>(grantKey(id)) : undefined;
	}

	/** The record whose secret hash matches, live or not, or 401. */
	private async matchingRecord(body: GrantCredentialBody): Promise<DownloadGrantRecord | Response> {
		const record = await this.recordOf(body.id);
		const secretHash = typeof body.secretHash === "string" ? body.secretHash : "";
		if (!record || !isConstantTimeEqual(secretHash, record.secretHash)) return invalidGrant();
		return record;
	}

	/** The live record whose secret hash matches, or the response explaining why not. */
	private async liveRecord(body: GrantCredentialBody): Promise<DownloadGrantRecord | Response> {
		const record = await this.matchingRecord(body);
		if (record instanceof Response) return record;
		if (isGrantDead(record)) return grantGone();
		return record;
	}

	private async identify(body: GrantCredentialBody): Promise<Response> {
		const record = await this.matchingRecord(body);
		return record instanceof Response ? record : Response.json(grantInfoOf(record));
	}

	private async authorize(body: GrantCredentialBody): Promise<Response> {
		const record = await this.liveRecord(body);
		return record instanceof Response ? record : Response.json(grantInfoOf(record));
	}

	/** Spends one link: caps first (a refused link spends nothing), then the total. */
	private async issue(body: IssueBody): Promise<Response> {
		const record = await this.liveRecord(body);
		if (record instanceof Response) return record;
		if (!fitsLinkCaps(record.link, Number(body.expiresIn), Number(body.maxUses))) {
			return Response.json(
				{
					error: "The link exceeds the grant's caps",
					code: DownloadGrantErrorCode.LINK_EXCEEDS_GRANT,
					link: record.link,
				},
				{ status: 400 },
			);
		}
		if (record.linksIssued >= record.maxLinks) {
			return failure(410, DownloadGrantErrorCode.EXHAUSTED, "This download grant has issued all its links");
		}
		const spent = { ...record, linksIssued: record.linksIssued + 1 };
		await this.storage.put(grantKey(record.id), spent);
		return Response.json(grantInfoOf(spent));
	}

	private async refund(body: GrantCredentialBody): Promise<Response> {
		const record = await this.recordOf(body.id);
		if (!record) return notFound();
		await this.storage.put(grantKey(record.id), { ...record, linksIssued: Math.max(0, record.linksIssued - 1) });
		return new Response(null, { status: 204 });
	}

	/** Without `secretHash` the route already authorized the owner; with it, only the grant's own secret revokes it. */
	private async revoke(body: GrantCredentialBody): Promise<Response> {
		const record = await this.recordOf(body.id);
		if (!record) return body.secretHash === undefined ? notFound() : invalidGrant();
		const isBearer = body.secretHash !== undefined;
		if (isBearer && !isConstantTimeEqual(String(body.secretHash), record.secretHash)) return invalidGrant();
		if (record.revokedAt !== null) return Response.json(grantInfoOf(record));
		const revoked = { ...record, revokedAt: Date.now() };
		await this.storage.put(grantKey(record.id), revoked);
		return Response.json(grantInfoOf(revoked));
	}

	private async getOne(body: GrantCredentialBody): Promise<Response> {
		const record = await this.recordOf(body.id);
		return record ? Response.json(grantInfoOf(record)) : notFound();
	}

	private async records(): Promise<DownloadGrantRecord[]> {
		const stored = await this.storage.list<DownloadGrantRecord>({ prefix: GRANT_KEY_PREFIX });
		return [...stored.values()];
	}

	private async list(): Promise<Response> {
		const records = await this.records();
		return Response.json(records.sort((first, second) => first.createdAt - second.createdAt).map(grantInfoOf));
	}

	private async revokeAll(): Promise<Response> {
		const now = Date.now();
		for (const record of await this.records()) {
			if (record.revokedAt === null) await this.storage.put(grantKey(record.id), { ...record, revokedAt: now });
		}
		return new Response(null, { status: 204 });
	}

	/** Alarm at the earliest expiry among the stored grants; none left: no alarm. */
	private async scheduleAlarm(): Promise<void> {
		const expiries = (await this.records()).map((record) => record.expiresAt);
		if (expiries.length === 0) {
			await this.storage.deleteAlarm();
			return;
		}
		await this.storage.setAlarm(Math.min(...expiries));
	}

	/** Drops the grants past their expiry (revoked ones stay listed until then) and schedules the next alarm. */
	async alarm(): Promise<void> {
		const now = Date.now();
		for (const record of await this.records()) {
			if (record.expiresAt <= now) await this.storage.delete(grantKey(record.id));
		}
		await this.scheduleAlarm();
	}
}
