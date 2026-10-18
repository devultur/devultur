import { describe, expect, it } from "vitest";
import { coversScope, missingScopes, TokenScope } from "./token-scopes";

describe("token scopes", () => {
	it("covers the exact scope or `*`", () => {
		expect(coversScope([TokenScope.MEDIA_READ], TokenScope.MEDIA_READ)).toBe(true);
		expect(coversScope([TokenScope.ALL], "anything")).toBe(true);
		expect(coversScope(["media:write"], TokenScope.MEDIA_READ)).toBe(false);
	});

	it("lists what the granted scopes don't cover, with a custom rule when given", () => {
		expect(missingScopes(["media:read"], ["media:read", "media:write"])).toEqual(["media:write"]);
		const exactOnly = (granted: readonly string[], required: string) => granted.includes(required);
		expect(missingScopes(["*"], ["media:read"], exactOnly)).toEqual(["media:read"]);
	});
});
