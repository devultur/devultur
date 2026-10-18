// Boundary guard: the published packages are standalone. Fails when a package depends on a @devultur package that
// isn't in this repo, or when its source imports a file outside its own package by relative path (it wouldn't be in
// the published tarball).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const PUBLISHED_PACKAGES = ["core", "server", "react", "convex", "self-host"];
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|mjs)$/;
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

function sourceFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((entry) => {
		const entryPath = join(directory, entry);
		if (statSync(entryPath).isDirectory()) return sourceFiles(entryPath);
		return SOURCE_EXTENSIONS.test(entry) ? [entryPath] : [];
	});
}

function readManifest(directory: string) {
	return JSON.parse(readFileSync(join(PACKAGES_DIR, directory, "package.json"), "utf8"));
}

const workspacePackageNames = readdirSync(PACKAGES_DIR).map((directory) => readManifest(directory).name as string);

function declaredDependencies(directory: string): string[] {
	const manifest = readManifest(directory);
	return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((field) =>
		Object.keys(manifest[field] ?? {}),
	);
}

/** Relative imports of `file` that resolve outside `packageDir`. */
function importsOutside(file: string, packageDir: string): string[] {
	const source = readFileSync(file, "utf8");
	return [...source.matchAll(RELATIVE_IMPORT)]
		.map(([, specifier]) => specifier)
		.filter((specifier) => relative(packageDir, resolve(dirname(file), specifier)).startsWith(".."))
		.map((specifier) => `${relative(ROOT, file)} imports ${specifier}`);
}

describe("open-source boundary guard", () => {
	it.each(PUBLISHED_PACKAGES)("packages/%s only depends on @devultur packages from this repo", (directory) => {
		const outsideDependencies = declaredDependencies(directory).filter(
			(name) => (name.startsWith("@devultur/") || name === "devultur") && !workspacePackageNames.includes(name),
		);
		expect(outsideDependencies).toEqual([]);
	});

	it.each(PUBLISHED_PACKAGES)("packages/%s/src imports nothing outside its package", (directory) => {
		const packageDir = join(PACKAGES_DIR, directory);
		const outside = sourceFiles(join(packageDir, "src")).flatMap((file) => importsOutside(file, packageDir));
		expect(outside).toEqual([]);
	});
});
