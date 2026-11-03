import { afterEach, describe, expect, it, vi } from "vitest";
import { DevulturApiError } from "./api-error";
import { createGrantClient } from "./grant-client";
import { createWorkerClient } from "./worker-client";

const BASE = "https://api.test";
const API_KEY = "sk_abcdefghijklmnopqrstuvwxyz012345";
const GRANT = `dvg_${"a".repeat(64)}.${"b".repeat(22)}.${"c".repeat(43)}`;
const PUBLIC_ID = `dgr_${"a".repeat(64)}.${"b".repeat(22)}`;

interface Call {
	url: string;
	init?: RequestInit;
}

function stubFetch(respond: (call: Call) => Response) {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const call = { url, init };
			calls.push(call);
			return respond(call);
		}),
	);
	return calls;
}

const authorizationOf = (call: Call) => new Headers(call.init?.headers).get("Authorization");

afterEach(() => vi.unstubAllGlobals());

describe("files: download grants", () => {
	it("creates a grant for one key with the owner's credential", async () => {
		const calls = stubFetch(() => Response.json({ grant: GRANT, id: PUBLIC_ID }));
		const files = createWorkerClient(API_KEY, BASE).files;
		const created = await files.createDownloadGrant("private/asset/exports/a.zip", {
			link: { maxExpiresIn: 300, maxUses: 1 },
			maxLinks: 50,
			canDelete: true,
			metadata: { exportId: "42" },
		});

		expect(created).toEqual({ grant: GRANT, id: PUBLIC_ID });
		expect(calls[0].url).toBe(`${BASE}/v1/token/grant`);
		expect(calls[0].init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			key: "private/asset/exports/a.zip",
			link: { maxExpiresIn: 300, maxUses: 1 },
			maxLinks: 50,
			canDelete: true,
			metadata: { exportId: "42" },
		});
		expect(authorizationOf(calls[0])).toBe(`Bearer ${API_KEY}`);
	});

	it("lists a file's grants and revokes one by its public id", async () => {
		const calls = stubFetch(({ init }) =>
			init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json([{ id: PUBLIC_ID }]),
		);
		const files = createWorkerClient(API_KEY, BASE).files;

		expect(await files.listDownloadGrants("private/asset/exports/a b.zip")).toEqual([{ id: PUBLIC_ID }]);
		expect(calls[0].url).toBe(`${BASE}/v1/token/grant?key=private%2Fasset%2Fexports%2Fa%20b.zip`);
		await files.revokeDownloadGrant(PUBLIC_ID);
		expect(calls[1].url).toBe(`${BASE}/v1/token/grant/${PUBLIC_ID}`);
		expect(calls[1].init?.method).toBe("DELETE");
	});
});

describe("createGrantClient", () => {
	it("reads the head with the grant as its only credential", async () => {
		const calls = stubFetch(
			() =>
				new Response(null, {
					headers: {
						"content-length": "1024",
						"content-type": "application/zip",
						"x-devultur-sha256": "f".repeat(64),
						"x-devultur-sha256-verified": "false",
						"x-devultur-expires-at": "1800000600000",
						"x-devultur-encrypted": "true",
						"x-devultur-grant-key": "private/asset/exports/a.zip",
						"x-devultur-grant-expires-at": "1800000500000",
						"x-devultur-grant-metadata": encodeURIComponent(JSON.stringify({ exportId: "42" })),
					},
				}),
		);
		const head = await createGrantClient(GRANT, BASE).head();

		expect(head).toMatchObject({
			key: "private/asset/exports/a.zip",
			size: 1024,
			sha256: "f".repeat(64),
			sha256Verified: false,
			expiresAt: 1_800_000_600_000,
			encrypted: true,
			metadata: { exportId: "42" },
			grantExpiresAt: 1_800_000_500_000,
		});
		expect(calls[0].url).toBe(`${BASE}/v1/grant/file`);
		expect(calls[0].init?.method).toBe("HEAD");
		expect(authorizationOf(calls[0])).toBe(`Bearer ${GRANT}`);
		expect(calls[0].url).not.toContain(GRANT);
	});

	it("answers null once the grant or its file is gone, and throws on an invalid grant", async () => {
		stubFetch(() => new Response(null, { status: 410 }));
		expect(await createGrantClient(GRANT, BASE).head()).toBeNull();
		stubFetch(() => new Response(null, { status: 401 }));
		await expect(createGrantClient(GRANT, BASE).head()).rejects.toBeInstanceOf(DevulturApiError);
	});

	it("issues links and surfaces the grant's refusals with their codes", async () => {
		const link = { id: "l".repeat(22), url: `${BASE}/v1/download/${"l".repeat(22)}`, expiresAt: 1, maxUses: 1 };
		const calls = stubFetch(({ init }) => {
			const body = JSON.parse(String(init?.body));
			if (body.expiresIn > 300) {
				return Response.json({ error: "too long", code: "link_exceeds_grant" }, { status: 400 });
			}
			return Response.json(link);
		});
		const client = createGrantClient(GRANT, BASE);

		expect(await client.createDownloadLink({ expiresIn: 300, filename: "a.zip", metadata: { ownerId: "u1" } })).toEqual(
			link,
		);
		expect(calls[0].url).toBe(`${BASE}/v1/grant/links`);
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			expiresIn: 300,
			filename: "a.zip",
			metadata: { ownerId: "u1" },
		});
		await expect(client.createDownloadLink({ expiresIn: 301 })).rejects.toMatchObject({
			status: 400,
			code: "link_exceeds_grant",
		});
	});

	it("deletes the file and revokes the grant", async () => {
		const calls = stubFetch(() => new Response(null, { status: 204 }));
		const client = createGrantClient(GRANT, BASE);
		await client.delete();
		await client.revoke();
		expect(calls.map((call) => [call.init?.method, call.url])).toEqual([
			["DELETE", `${BASE}/v1/grant/file`],
			["DELETE", `${BASE}/v1/grant`],
		]);
	});
});
