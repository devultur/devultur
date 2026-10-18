// Durable Object `DownloadLink`: the state of ONE download link (one instance per id, `idFromName(id)`). A
// single-use link needs an atomic counter and KV is eventually consistent; a DO serializes requests to the
// same instance, and the redemption runs inside `blockConcurrencyWhile`: the `get → uses+1 → put` never interleaves
// with another redemption (even if a non-storage await is added), so two simultaneous redemptions never
// consume the same use. An alarm on expiry clears the state. No `cloudflare:workers` import (a class with `fetch`): it can be instantiated in Node tests with a fake
// storage.
import type { PluginContext } from "./request-state";

export interface DownloadLinkRecord {
	/** Full storage key (with the storage prefix). */
	storageKey: string;
	/** Virtual key (`{visibility}/…`). */
	key: string;
	/** Epoch ms. */
	expiresAt: number;
	maxUses: number;
	uses: number;
	filename?: string;
	/** Storage prefix the link was issued under. */
	storagePrefix: string;
	/** Plugin context of the request that issued the link (opaque to the Worker). */
	context?: PluginContext;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Plugin context of a link record. Pure. */
export function recordContext(record: DownloadLinkRecord): PluginContext | undefined {
	if (record.context) return record.context;
	// TODO(remove after 2026-10-31): a link created before the field rename (links live up to 7 days) keeps it under
	// its legacy field name.
	const legacy = (record as unknown as Record<string, unknown>).callerContext;
	return isRecord(legacy) ? (legacy as PluginContext) : undefined;
}

export const DownloadLinkPath = {
	CREATE: "/create",
	REDEEM: "/redeem",
	/** Reads the link without consuming a use (same 404/410 as redemption): the `beforeLinkRedeem` hook decides first. */
	PEEK: "/peek",
} as const;

/** Storage surface of a DO that the class uses (the Workers one satisfies it; tests pass a Map). */
export interface DownloadLinkStorage {
	get<T>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
	deleteAll(): Promise<void>;
	setAlarm(scheduledTime: number): Promise<void>;
}

/** Surface of the `DurableObjectState` the class uses. */
export interface DownloadLinkState {
	storage: DownloadLinkStorage;
	blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

const RECORD_KEY = "link";

const linkGone = (code: string, error: string) => Response.json({ error, code }, { status: 410 });

export class DownloadLink {
	private readonly state: DownloadLinkState;
	private readonly storage: DownloadLinkStorage;

	constructor(state: DownloadLinkState) {
		this.state = state;
		this.storage = state.storage;
	}

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method !== "POST") return new Response(null, { status: 405 });
		if (pathname === DownloadLinkPath.CREATE) return this.state.blockConcurrencyWhile(() => this.create(request));
		if (pathname === DownloadLinkPath.REDEEM) return this.state.blockConcurrencyWhile(() => this.redeem());
		if (pathname === DownloadLinkPath.PEEK) return this.state.blockConcurrencyWhile(() => this.peek());
		return new Response(null, { status: 404 });
	}

	private async create(request: Request): Promise<Response> {
		if (await this.storage.get<DownloadLinkRecord>(RECORD_KEY)) {
			return Response.json({ error: "Link id already in use", code: "link_exists" }, { status: 409 });
		}
		const record = (await request.json()) as DownloadLinkRecord;
		await this.storage.put(RECORD_KEY, { ...record, uses: 0 });
		await this.storage.setAlarm(record.expiresAt);
		return Response.json({ ok: true }, { status: 201 });
	}

	/** The record if it still has a use left, or the response explaining why not: 404 if it never existed (or the alarm already
	 *  cleared it), 410 if it expired or was already used. */
	private async usableRecord(): Promise<DownloadLinkRecord | Response> {
		const record = await this.storage.get<DownloadLinkRecord>(RECORD_KEY);
		if (!record) return Response.json({ error: "Download link not found", code: "link_not_found" }, { status: 404 });
		if (record.expiresAt <= Date.now()) return linkGone("link_expired", "This download link has expired");
		if (record.uses >= record.maxUses) return linkGone("link_used", "This download link was already used");
		return record;
	}

	private async peek(): Promise<Response> {
		const record = await this.usableRecord();
		return record instanceof Response ? record : Response.json(record);
	}

	/** Consumes ONE use. */
	private async redeem(): Promise<Response> {
		const record = await this.usableRecord();
		if (record instanceof Response) return record;
		const consumed = { ...record, uses: record.uses + 1 };
		await this.storage.put(RECORD_KEY, consumed);
		return Response.json(consumed);
	}

	async alarm(): Promise<void> {
		await this.storage.deleteAll();
	}
}
