import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEVULTUR_ERROR_CODES } from "../src/error-codes";

// Every `code` the Worker, core and the component send must be in `DEVULTUR_ERROR_CODES` (and so have a label in each
// locale). It reads the sources instead of importing them: a new refusal fails here until its code is listed.
// It lives outside `src` because it reads other packages' sources (see scripts/oss-leak-guard.test.ts).

const PACKAGES_DIR = join(import.meta.dirname, "..", "..");
const SCANNED = ["self-host/src", "core/src", "convex/src"];
const NOT_SOURCE = /\.test\.tsx?$|fixture|harness|_generated/;

// `code: "x"`, the routes' `failure(400, "x", …)` / `badRequest(context, "x", …)` / `linkGone("x", …)`, `X_CODE = "x"`.
const CODE_LITERALS = [
	/code: "([a-z0-9_]+)"/g,
	/failure\(\d{3}, "([a-z0-9_]+)"/g,
	/badRequest\(context, "([a-z0-9_]+)"/g,
	/linkGone\("([a-z0-9_]+)"/g,
	/_CODE = "([a-z0-9_]+)"/g,
	/new MediaFetchError\("([a-z0-9_]+)"/g,
];
// `const XErrorCode = { A: "x", ... }` objects, and the lock route's `refusal(…, reason)` (`LockChangeReason`).
const CODE_OBJECTS = /ErrorCode = \{([^}]*)\}/g;
const LOCK_CHANGE_REASON = /type LockChangeReason = ([^;]*);/g;
const QUOTED = /"([a-z0-9_]+)"/g;

function sourceFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((entry) => {
		const entryPath = join(directory, entry);
		if (statSync(entryPath).isDirectory()) return sourceFiles(entryPath);
		return /\.tsx?$/.test(entry) && !NOT_SOURCE.test(entryPath) ? [entryPath] : [];
	});
}

function codesIn(source: string): string[] {
	const literals = CODE_LITERALS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
	const grouped = [CODE_OBJECTS, LOCK_CHANGE_REASON].flatMap((pattern) =>
		[...source.matchAll(pattern)].flatMap((match) => [...match[1].matchAll(QUOTED)].map((quoted) => quoted[1])),
	);
	return [...literals, ...grouped];
}

describe("error codes", () => {
	const emitted = new Set(
		SCANNED.flatMap((directory) => sourceFiles(join(PACKAGES_DIR, directory))).flatMap((file) =>
			codesIn(readFileSync(file, "utf8")),
		),
	);

	it("finds the codes it scans for", () => {
		expect(emitted).toContain("file_too_large");
		expect(emitted).toContain("compliance_extend_only");
		expect(emitted).toContain("captions_provider_rate_limited");
		expect(emitted).toContain("too_large");
	});

	it("lists every code the sources emit", () => {
		const listed: ReadonlySet<string> = new Set(DEVULTUR_ERROR_CODES);
		expect([...emitted].filter((code) => !listed.has(code)).sort()).toEqual([]);
	});
});
