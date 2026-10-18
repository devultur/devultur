import { describe, expect, it } from "vitest";
import {
	CACHE_CONTROL_PRESETS,
	edgeTtlSeconds,
	matchCacheRule,
	normalizeCacheRules,
	resolveCacheControl,
	toPrivateCacheControl,
} from "./cache-control";

describe("resolveCacheControl", () => {
	it("resolves the presets", () => {
		expect(resolveCacheControl("immutable")).toBe(CACHE_CONTROL_PRESETS.immutable);
		expect(resolveCacheControl("revalidate")).toBe("public, max-age=86400, stale-while-revalidate=86400");
		expect(resolveCacheControl("no-cache")).toBe("public, no-cache");
	});

	it("normalizes a valid raw string", () => {
		expect(resolveCacheControl("Public,  MAX-AGE=300 ,s-maxage=600")).toBe("public, max-age=300, s-maxage=600");
	});

	it.each([
		"",
		"public, max-age=abc",
		"public, max-age=99999999",
		"public, private",
		"max-age=1, max-age=2",
		"public, x-evil=1",
		"public\r\nSet-Cookie: a=b",
		`public, ${"immutable, ".repeat(30)}`,
		42,
	])("rejects %j", (input) => {
		expect(resolveCacheControl(input)).toBeNull();
	});
});

describe("edgeTtlSeconds", () => {
	it("uses s-maxage over max-age, capped", () => {
		expect(edgeTtlSeconds("public, max-age=60, s-maxage=3600", 86400)).toBe(3600);
		expect(edgeTtlSeconds("public, max-age=60", 86400)).toBe(60);
		expect(edgeTtlSeconds(CACHE_CONTROL_PRESETS.immutable, 604800)).toBe(604800);
	});

	it("doesn't cache what shouldn't go into a shared cache", () => {
		expect(edgeTtlSeconds("public, no-cache", 86400)).toBe(0);
		expect(edgeTtlSeconds("no-store", 86400)).toBe(0);
		expect(edgeTtlSeconds("private, max-age=60", 86400)).toBe(0);
		expect(edgeTtlSeconds(undefined, 86400)).toBe(0);
	});
});

describe("toPrivateCacheControl", () => {
	it("changes public to private and strips shared-cache directives", () => {
		expect(toPrivateCacheControl("public, max-age=60, s-maxage=600, stale-while-revalidate=86400")).toBe(
			"private, max-age=60, stale-while-revalidate=86400",
		);
	});
});

describe("cache rules", () => {
	const rules = normalizeCacheRules([
		{ prefix: "", cacheControl: "no-cache" },
		{ prefix: "site", cacheControl: "revalidate" },
		{ prefix: "site/static/", cacheControl: "immutable" },
	]);

	it("normalizes prefixes and presets", () => {
		expect(rules?.map((rule) => rule.prefix)).toEqual(["", "site/", "site/static/"]);
		expect(rules?.[2]?.cacheControl).toBe(CACHE_CONTROL_PRESETS.immutable);
	});

	it("the longest prefix wins", () => {
		expect(matchCacheRule(rules ?? [], "site/static/app.123.js")?.prefix).toBe("site/static/");
		expect(matchCacheRule(rules ?? [], "site/index.html")?.prefix).toBe("site/");
		expect(matchCacheRule(rules ?? [], "docs/a.pdf")?.prefix).toBe("");
		expect(matchCacheRule([], "docs/a.pdf")).toBeNull();
	});

	it("rejects invalid or repeated prefixes, or an invalid cache-control", () => {
		expect(normalizeCacheRules([{ prefix: "../x", cacheControl: "immutable" }])).toBeNull();
		expect(normalizeCacheRules([{ prefix: "a/", cacheControl: "bogus" }])).toBeNull();
		expect(
			normalizeCacheRules([
				{ prefix: "a", cacheControl: "immutable" },
				{ prefix: "a/", cacheControl: "no-cache" },
			]),
		).toBeNull();
		expect(normalizeCacheRules("nope")).toBeNull();
	});
});
