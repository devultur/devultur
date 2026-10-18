import { describe, expect, it } from "vitest";
import { signViewerToken, verifyViewerToken } from "./helpers";
import { withCurrentClaimNames } from "./legacy-claims";
import { uploadGrantFromClaims } from "./routes/token-upload";
import { viewerTokenClaimRejection } from "./routes/viewer-token-claims";

// TODO(remove after 2026-10-31) with legacy-claims.ts: tokens signed before the claim rename keep working until they
// expire.

const SECRET = "delivery-sign-secret";
const KEY = "private/image/clientA/photo.jpg";

describe("legacy claim names", () => {
	it("are read as the current ones, and the current one wins", () => {
		expect(withCurrentClaimNames({ pid: "a", ppx: "image/", scopes: ["media:read", "x"] })).toEqual({
			aud: "a",
			res: "image/",
			scope: "media:read x",
		});
		expect(withCurrentClaimNames({ pid: "old", aud: "new" })).toEqual({ aud: "new" });
	});

	it("never turn a malformed legacy scope list into an unlimited token", () => {
		expect(withCurrentClaimNames({ scopes: "media:read" })).toEqual({ scope: "" });
	});

	it("keep a legacy viewer token bound to its storage prefix, path prefix and scopes", async () => {
		const exp = Math.floor(Date.now() / 1000) + 60;
		const legacy = await signViewerToken({ sub: "u", exp, pid: "prefix-a", ppx: "image/clientA/" }, SECRET);
		const payload = (await verifyViewerToken(legacy, SECRET)) as Record<string, unknown>;
		expect(viewerTokenClaimRejection(payload, { storagePrefix: "prefix-a/", key: KEY })).toBeNull();
		expect(viewerTokenClaimRejection(payload, { storagePrefix: "prefix-b/", key: KEY })).toMatchObject({
			reason: "audience",
		});
		const writeOnly = await signViewerToken({ sub: "u", exp, scopes: ["media:write"] }, SECRET);
		const writePayload = (await verifyViewerToken(writeOnly, SECRET)) as Record<string, unknown>;
		expect(viewerTokenClaimRejection(writePayload, { storagePrefix: "", key: KEY })).toMatchObject({ reason: "scope" });
	});

	it("keep a legacy upload token's grant", async () => {
		const exp = Math.floor(Date.now() / 1000) + 60;
		const legacy = await signViewerToken(
			{ typ: "upload", jti: "j", pfx: "asset/ci/", vis: "public", mxb: 10, mxf: 2, fttl: 60, exp },
			SECRET,
		);
		const payload = (await verifyViewerToken(legacy, SECRET)) as Record<string, unknown>;
		expect(uploadGrantFromClaims(payload)).toEqual({
			tokenId: "j",
			pathPrefix: "asset/ci/",
			visibility: "public",
			maxBytes: 10,
			maxFiles: 2,
			fileExpiresIn: 60,
		});
	});
});
